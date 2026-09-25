/**
 * Backend benchmark: so sánh 4 cách đẩy dữ liệu real-time xuống client,
 * đều được kích hoạt bởi CÙNG MỘT NGUỒN: Postgres LISTEN/NOTIFY.
 *
 * 1) GET  /poll        - Polling (client tự hỏi định kỳ)
 * 2) GET  /sse         - Server-Sent Events (stream một chiều)
 * 3) WS   /ws          - WebSocket (hai chiều, giữ kết nối)
 * 4) FCM  /fcm/* - Mô phỏng Firebase Cloud Messaging (push qua bên thứ 3)
 *
 * Luồng dữ liệu:
 * POST /messages -> INSERT vào Postgres -> trigger DB bắn pg_notify()
 * -> server LISTEN nhận notification -> phát lại cho cả 4 kênh trên
 * qua một EventEmitter dùng chung (bus).
 *
 * Điều này đảm bảo khi so sánh 4 phương pháp, độ trễ đo được là độ trễ
 * thực của TỪNG KÊNH TRUYỀN, không lệch do nguồn phát khác nhau.
 */

const express = require('express');
const http = require('http');
const { spawn } = require('child_process');
const { Client } = require('pg');
const WebSocket = require('ws');
const { EventEmitter } = require('events');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind vào 0.0.0.0 để lắng nghe tất cả các network interface trong WSL/Docker
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/notifybench';
const CHANNEL = 'new_message';

// Khoá ký JWT — trong đồ án chạy local dùng tạm giá trị mặc định cũng được,
// nhưng nên đặt JWT_SECRET riêng trong .env nếu deploy cho nhiều người dùng thật.
const JWT_SECRET = process.env.JWT_SECRET || 'notify-benchmark-dev-secret-doi-neu-deploy-that';
if (!process.env.JWT_SECRET) {
  console.warn('[auth] Đang dùng JWT_SECRET mặc định — đặt biến môi trường JWT_SECRET riêng nếu deploy thật.');
}

const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);

// Event bus nội bộ, được "bơm" bởi Postgres NOTIFY, và mọi kênh
// (SSE/WS/FCM) chỉ việc subscribe vào đây.
const bus = new EventEmitter();
bus.setMaxListeners(0);

// Buffer trong bộ nhớ để phục vụ endpoint Polling (tránh query DB mỗi lần poll)
const recentMessages = [];
const MAX_BUFFER = 5000;

// ---------------------------------------------------------------
// 1. Kết nối Postgres, LISTEN kênh new_message
// ---------------------------------------------------------------
const pgClient = new Client({ connectionString: DATABASE_URL });

async function initPg() {
  await pgClient.connect();

  // Tự áp migration nhỏ (thêm cột sender + cập nhật trigger) mỗi lần khởi
  // động — an toàn để chạy lặp lại (IF NOT EXISTS / CREATE OR REPLACE),
  // phòng khi DB đã được tạo từ bản schema.sql cũ chưa có cột sender.
  await pgClient.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id BIGSERIAL PRIMARY KEY,
      content TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT 'anonymous';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS room TEXT NOT NULL DEFAULT 'lobby';

    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
    CREATE OR REPLACE FUNCTION notify_new_message() RETURNS trigger AS $f$
    BEGIN
      PERFORM pg_notify(
        'new_message',
        json_build_object('id', NEW.id, 'content', NEW.content, 'sender', NEW.sender, 'room', NEW.room, 'created_at', NEW.created_at)::text
      );
      RETURN NEW;
    END;
    $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_notify_new_message ON messages;
    CREATE TRIGGER trg_notify_new_message AFTER INSERT ON messages
    FOR EACH ROW EXECUTE FUNCTION notify_new_message();
  `);

  await pgClient.query(`LISTEN ${CHANNEL}`);
  pgClient.on('notification', (msg) => {
    try {
      const payload = JSON.parse(msg.payload);
      recentMessages.push(payload);
      if (recentMessages.length > MAX_BUFFER) recentMessages.shift();
      bus.emit('message', payload);
    } catch (err) {
      console.error('[pg] Bad NOTIFY payload:', err.message);
    }
  });
  pgClient.on('error', (err) => console.error('[pg] client error:', err.message));
  console.log(`[pg] LISTEN ${CHANNEL} sẵn sàng`);
}

// ---------------------------------------------------------------
// Endpoint tạo message (nguồn phát chung cho mọi kênh)
// ---------------------------------------------------------------
app.post('/messages', async (req, res) => {
  const { content, sender, room } = req.body || {};
  if (!content) return res.status(400).json({ error: 'content required' });
  try {
    const createdAt = new Date();
    const result = await pgClient.query(
      'INSERT INTO messages(content, sender, room, created_at) VALUES ($1, $2, $3, $4) RETURNING id, content, sender, room, created_at',
      [content, sender || 'anonymous', room || 'lobby', createdAt]
    );
    res.status(201).json(result.rows[0]);
  } catch (err) {
    console.error('[insert] error:', err.message);
    res.status(500).json({ error: 'insert failed' });
  }
});

// ---------------------------------------------------------------
// DANH SÁCH PHÒNG — mọi phòng đã từng có tin nhắn, mới nhất trước.
// Lấy từ chính bảng messages nên dùng chung được trên mọi trình duyệt/máy,
// không phụ thuộc localStorage của riêng 1 máy.
// ---------------------------------------------------------------
app.get('/rooms', async (req, res) => {
  try {
    const result = await pgClient.query(`
      SELECT room, COUNT(*)::int AS msg_count, MAX(id) AS last_id, MAX(created_at) AS last_at
      FROM messages
      GROUP BY room
      ORDER BY last_id DESC
      LIMIT 30
    `);
    res.json({ rooms: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// LỊCH SỬ CHAT — nạp N tin nhắn gần nhất của 1 phòng khi mở trang chat.
// Không truyền ?room= -> mặc định 'lobby' (phòng chung).
// ---------------------------------------------------------------
app.get('/messages', async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const room = req.query.room || 'lobby';
  try {
    const result = await pgClient.query(
      'SELECT id, content, sender, room, created_at FROM messages WHERE room = $1 ORDER BY id DESC LIMIT $2',
      [room, limit]
    );
    res.json({ items: result.rows.reverse() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// 1) POLLING
// Client tự gọi lại định kỳ, kèm mốc thời gian lần lấy cuối (since).
// ---------------------------------------------------------------
app.get('/poll', (req, res) => {
  const since = req.query.since ? new Date(req.query.since) : new Date(0);
  const room = req.query.room; // không truyền -> không lọc, giữ đúng hành vi benchmark cũ
  const items = recentMessages.filter(
    (m) => new Date(m.created_at) > since && (!room || m.room === room)
  );
  res.json({ items, serverTime: new Date().toISOString() });
});

// ---------------------------------------------------------------
// 2) SERVER-SENT EVENTS
// Giữ kết nối HTTP mở, đẩy dữ liệu 1 chiều server -> client.
// ---------------------------------------------------------------
app.get('/sse', (req, res) => {
  const room = req.query.room; // không truyền -> không lọc

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  const onMessage = (payload) => {
    if (room && payload.room !== room) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  bus.on('message', onMessage);

  // heartbeat để giữ proxy/load-balancer không đóng kết nối idle
  const heartbeat = setInterval(() => res.write(':hb\n\n'), 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    bus.off('message', onMessage);
  });
});

// ---------------------------------------------------------------
// 3) WEBSOCKET
// Hai chiều, chi phí giữ kết nối cao nhất nhưng độ trễ thấp nhất.
// ---------------------------------------------------------------
const wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('connection', (ws, req) => {
  const room = new URL(req.url, 'http://x').searchParams.get('room'); // null -> không lọc
  const onMessage = (payload) => {
    if (room && payload.room !== room) return;
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  };
  bus.on('message', onMessage);
  ws.on('close', () => bus.off('message', onMessage));
  ws.on('error', () => bus.off('message', onMessage));
});

// ---------------------------------------------------------------
// 4) FCM (MÔ PHỎNG)
// FCM thật cần firebase-admin + service account + token thiết bị thật,
// nên không thể test tại đây. Phần dưới mô phỏng đúng "hình dạng" chi phí:
// độ trễ round-trip qua một bên thứ ba (push provider), để đưa vào cùng
// khung benchmark so sánh với 3 kênh trên.
// ---------------------------------------------------------------
const fcmTokens = new Set();
const fcmSent = [];
const fcmBus = new EventEmitter();
fcmBus.setMaxListeners(0);

app.post('/fcm/register', (req, res) => {
  const { token } = req.body || {};
  if (!token) return res.status(400).json({ error: 'token required' });
  fcmTokens.add(token);
  res.json({ registered: true, total: fcmTokens.size });
});

bus.on('message', async (payload) => {
  if (fcmTokens.size === 0) return;
  // Độ trễ round-trip mô phỏng khi gọi ra provider push bên ngoài (50-150ms)
  await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
  const delivered = { ...payload, deliveredAt: new Date().toISOString(), tokens: fcmTokens.size };
  fcmSent.push(delivered);
  if (fcmSent.length > 500) fcmSent.shift();
  // Đẩy thật (push) cho các client đang mở /fcm/stream, thay vì bắt client tự
  // polling /fcm/sent — polling ở đây sẽ cộng thêm chu kỳ polling vào latency
  // đo được, làm sai lệch bản chất "push" của FCM so với 3 kênh còn lại.
  fcmBus.emit('fcm-message', delivered);
});

app.get('/fcm/sent', (req, res) => res.json(fcmSent.slice(-100)));

// ---------------------------------------------------------------
// FCM STREAM — kênh push thật cho benchmark/demo, tách khỏi /fcm/sent
// (endpoint /fcm/sent giữ lại chỉ để xem log thủ công, không dùng để đo latency)
// ---------------------------------------------------------------
app.get('/fcm/stream', (req, res) => {
  const room = req.query.room; // không truyền -> không lọc

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  const onFcm = (payload) => {
    if (room && payload.room !== room) return;
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };
  fcmBus.on('fcm-message', onFcm);

  const heartbeat = setInterval(() => res.write(':hb\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    fcmBus.off('fcm-message', onFcm);
  });
});

// ---------------------------------------------------------------
// METRICS - để load-test script sample CPU/RAM trong lúc chạy
// ---------------------------------------------------------------
app.get('/metrics', (req, res) => {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  res.json({
    timestamp: new Date().toISOString(),
    rssMB: +(mem.rss / 1024 / 1024).toFixed(2),
    heapUsedMB: +(mem.heapUsed / 1024 / 1024).toFixed(2),
    cpuUserMs: +(cpu.user / 1000).toFixed(2),
    cpuSystemMs: +(cpu.system / 1000).toFixed(2),
    wsClients: wss.clients.size,
  });
});

// ---------------------------------------------------------------
// RESULTS - đọc file CSV tổng hợp benchmark mới nhất (từ bench-all.sh)
// để dashboard UI (public/index.html) vẽ biểu đồ.
// ---------------------------------------------------------------
app.get('/results', (req, res) => {
  const dir = path.join(__dirname, 'loadtest', 'results');
  try {
    const csvFiles = fs
      .readdirSync(dir)
      .filter((f) => f.startsWith('summary-') && f.endsWith('.csv'))
      .sort();
    if (csvFiles.length === 0) return res.json({ file: null, rows: [] });

    const latest = csvFiles[csvFiles.length - 1];
    const content = fs.readFileSync(path.join(dir, latest), 'utf8').trim().split('\n');
    const header = content[0].split(',');
    const rows = content.slice(1).map((line) => {
      const cols = line.split(',');
      const row = {};
      header.forEach((h, i) => {
        const v = cols[i];
        row[h] = isNaN(Number(v)) ? v : Number(v);
      });
      return row;
    });
    res.json({ file: latest, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------
// ĐĂNG KÝ / ĐĂNG NHẬP / ĐĂNG XUẤT
// Mật khẩu hash bằng bcrypt, phiên đăng nhập lưu trong JWT ở cookie
// httpOnly (JS phía client không đọc được, hạn chế XSS đánh cắp token).
// Chỉ gác cổng GIAO DIỆN WEB — các endpoint /poll,/sse,/ws,/fcm/stream,
// POST /messages vẫn để mở như cũ vì bench-all.js/run.js gọi thẳng,
// không đăng nhập qua trình duyệt.
// ---------------------------------------------------------------
const COOKIE_NAME = 'nb_token';
const COOKIE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 ngày

function setAuthCookie(res, user) {
  const token = jwt.sign(
    { uid: user.id, username: user.username, displayName: user.display_name, role: user.role },
    JWT_SECRET,
    { expiresIn: '7d' }
  );
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: COOKIE_MAX_AGE_MS,
  });
}

app.post('/auth/register', async (req, res) => {
  const { username, password, displayName } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Cần username và password' });
  }
  if (username.length < 3 || password.length < 6) {
    return res.status(400).json({ error: 'Username tối thiểu 3 ký tự, mật khẩu tối thiểu 6 ký tự' });
  }
  try {
    const hash = await bcrypt.hash(password, 10);
    // Người đăng ký ĐẦU TIÊN của hệ thống tự động là admin — không cần
    // sửa DB thủ công. Từ người thứ 2 trở đi mặc định role 'user'.
    const countResult = await pgClient.query('SELECT COUNT(*)::int AS n FROM users');
    const role = countResult.rows[0].n === 0 ? 'admin' : 'user';
    const result = await pgClient.query(
      'INSERT INTO users(username, password_hash, display_name, role) VALUES ($1, $2, $3, $4) RETURNING id, username, display_name, role',
      [username.trim(), hash, (displayName || username).trim(), role]
    );
    const user = result.rows[0];
    setAuthCookie(res, user);
    res.status(201).json({ username: user.username, displayName: user.display_name, role: user.role });
  } catch (err) {
    if (err.code === '23505') { // unique_violation
      return res.status(409).json({ error: 'Username đã tồn tại' });
    }
    console.error('[auth/register] error:', err.message);
    res.status(500).json({ error: 'Đăng ký thất bại' });
  }
});

app.post('/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'Cần username và password' });
  }
  try {
    const result = await pgClient.query('SELECT * FROM users WHERE username = $1', [username.trim()]);
    const user = result.rows[0];
    if (!user) return res.status(401).json({ error: 'Sai username hoặc mật khẩu' });
    const ok = await bcrypt.compare(password, user.password_hash);
    if (!ok) return res.status(401).json({ error: 'Sai username hoặc mật khẩu' });
    setAuthCookie(res, user);
    res.json({ username: user.username, displayName: user.display_name, role: user.role });
  } catch (err) {
    console.error('[auth/login] error:', err.message);
    res.status(500).json({ error: 'Đăng nhập thất bại' });
  }
});

app.post('/auth/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME);
  res.json({ ok: true });
});

app.get('/auth/me', (req, res) => {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    res.json({ username: payload.username, displayName: payload.displayName || payload.username, role: payload.role || 'user' });
  } catch (e) {
    res.status(401).json({ error: 'Phiên đăng nhập hết hạn' });
  }
});

// ---------------------------------------------------------------
// ADMIN — danh sách user đã đăng ký. Chỉ role 'admin' mới xem được.
// ---------------------------------------------------------------
function getAuthUser(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch (e) {
    return null;
  }
}

app.get('/admin/users', async (req, res) => {
  const user = getAuthUser(req);
  if (!user) return res.status(401).json({ error: 'Chưa đăng nhập' });
  if (user.role !== 'admin') return res.status(403).json({ error: 'Chỉ admin mới xem được danh sách này' });
  try {
    const result = await pgClient.query(
      'SELECT id, username, display_name, role, created_at FROM users ORDER BY id ASC'
    );
    res.json({ users: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------
// CHẠY BENCHMARK TỪ UI — spawn loadtest/bench-all.js làm tiến trình con,
// stream log ra qua SSE để trang web hiện tiến trình chạy trực tiếp,
// xong tự báo 'done' để dashboard tải lại CSV mới nhất.
// ---------------------------------------------------------------
const benchBus = new EventEmitter();
benchBus.setMaxListeners(0);
let benchProcess = null;

app.get('/bench/status', (req, res) => {
  res.json({ running: !!benchProcess });
});

app.post('/bench/start', (req, res) => {
  if (benchProcess) {
    return res.status(409).json({ error: 'Benchmark đang chạy rồi, đợi xong đã.' });
  }
  // preset=quick dùng để test nhanh (vài giây), mặc định chạy đầy đủ như cấu hình gốc
  const preset = !!req.body?.preset;
  const env = Object.assign({}, process.env, {
    BASE_URL: `http://localhost:${PORT}`,
  });
  if (preset) {
    env.BENCH_CLIENTS = '5,20';
    env.BENCH_DURATION = '5';
  }

  benchProcess = spawn(process.execPath, [path.join(__dirname, 'loadtest', 'bench-all.js')], {
    cwd: __dirname,
    env,
  });

  benchBus.emit('log', `>>> Bắt đầu benchmark (${preset ? 'chạy nhanh' : 'chạy đầy đủ'})...\n`);

  benchProcess.stdout.on('data', (chunk) => benchBus.emit('log', chunk.toString()));
  benchProcess.stderr.on('data', (chunk) => benchBus.emit('log', chunk.toString()));
  benchProcess.on('close', (code) => {
    benchBus.emit('log', `\n>>> Benchmark kết thúc (exit code ${code}).\n`);
    benchBus.emit('done', { code });
    benchProcess = null;
  });
  benchProcess.on('error', (err) => {
    benchBus.emit('log', `\n>>> Lỗi khởi chạy benchmark: ${err.message}\n`);
    benchBus.emit('done', { code: -1 });
    benchProcess = null;
  });

  res.json({ started: true });
});

app.get('/bench/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('\n');

  const onLog = (text) => res.write(`event: log\ndata: ${JSON.stringify(text)}\n\n`);
  const onDone = (payload) => res.write(`event: done\ndata: ${JSON.stringify(payload)}\n\n`);
  benchBus.on('log', onLog);
  benchBus.on('done', onDone);

  const heartbeat = setInterval(() => res.write(':hb\n\n'), 25000);
  req.on('close', () => {
    clearInterval(heartbeat);
    benchBus.off('log', onLog);
    benchBus.off('done', onDone);
  });
});

initPg()
  .then(() => {
    // Sửa phần này: Thêm tham số HOST ('0.0.0.0') khi khởi động server
    server.listen(PORT, HOST, () => console.log(`Server chạy tại http://${HOST}:${PORT}`));
  })
  .catch((err) => {
    console.error('Không kết nối/LISTEN được Postgres:', err.message);
    process.exit(1);
  });