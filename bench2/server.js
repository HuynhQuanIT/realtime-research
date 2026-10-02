'use strict';
/**
 * bench2/server.js - server CHỈ dùng để đo (không auth, không static, không admin).
 *
 * Pipeline chung cho cả 4 cơ chế:
 *   POST /messages -> INSERT (Pool) -> trigger pg_notify -> LISTEN (1 client riêng)
 *   -> fan-out: /poll (ring buffer), /sse, /ws, /push (emulated)
 *
 * Khác bản cũ:
 *  - Message có seq (đơn điệu, gán lúc nhận NOTIFY) -> cursor của polling theo seq, không theo thời gian
 *  - Serialize JSON đúng 1 lần / message, dùng lại cho mọi client
 *  - /poll tra buffer theo chỉ số O(1), không quét + new Date()
 *  - Mỗi message mang tc (lúc tạo) và tb (lúc bus nhận) -> tách được latency từng chặng
 *  - /stats: CPU user+sys, RSS, heap, event-loop delay, ELU, GC, backlog, bộ đếm
 *  - /reset: TRUNCATE + xoá buffer + zero bộ đếm
 */
const http = require('http');
const { Pool, Client } = require('pg');
const WebSocket = require('ws');
const { monitorEventLoopDelay, PerformanceObserver, performance } = require('perf_hooks');

const PORT = +process.env.PORT || 3100;
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/notifybench';
const PUSH_MEDIAN_MS = +process.env.PUSH_MEDIAN_MS || 100;
const PUSH_SIGMA = +process.env.PUSH_SIGMA || 0.35;
const CHANNEL = 'bench_new_message';
const now = () => Number(process.hrtime.bigint()) / 1e6; // ms; hrtime cùng gốc cho MỌI tiến trình trên cùng máy (không lệch như timeOrigin)

// ---------- trạng thái ----------
let seq = 0;
let buf = []; // các message đã serialize (string); buf[0] có seq = bufStart
let bufStart = 1;
const sseClients = new Set();
const pushClients = new Set();
let wss;
const counters = { notify: 0, pollReq: 0, sseWrite: 0, wsSend: 0, pushSend: 0, insertErr: 0 };

// ---------- đo hiệu năng tiến trình ----------
const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();
let gcMs = 0;
new PerformanceObserver((list) => { for (const e of list.getEntries()) gcMs += e.duration; })
  .observe({ entryTypes: ['gc'] });
let lastElu = performance.eventLoopUtilization();

function backlog() {
  let max = 0;
  for (const r of sseClients) if (r.writableLength > max) max = r.writableLength;
  for (const r of pushClients) if (r.writableLength > max) max = r.writableLength;
  if (wss) for (const c of wss.clients) if (c.bufferedAmount > max) max = c.bufferedAmount;
  return max;
}

function stats() {
  const m = process.memoryUsage();
  const c = process.cpuUsage();
  const elu = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  const out = {
    t: now(),
    cpuUserUs: c.user, cpuSysUs: c.system,
    rssMB: m.rss / 1048576, heapMB: m.heapUsed / 1048576,
    eldP50: Math.max(0, eld.percentile(50) / 1e6 - 10), eldP99: Math.max(0, eld.percentile(99) / 1e6 - 10), eldMax: Math.max(0, eld.max / 1e6 - 10), // trừ resolution 10ms
    elu: elu.utilization, gcMs,
    backlogBytes: backlog(),
    sse: sseClients.size, ws: wss ? wss.clients.size : 0, push: pushClients.size,
    ...counters,
  };
  eld.reset();
  return out;
}

// ---------- DB ----------
const pool = new Pool({ connectionString: DATABASE_URL, max: 8 });
const listener = new Client({ connectionString: DATABASE_URL });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS bench_messages (
      id BIGSERIAL PRIMARY KEY, content TEXT NOT NULL, t_create DOUBLE PRECISION NOT NULL);
    CREATE OR REPLACE FUNCTION bench_notify() RETURNS trigger AS $f$
    BEGIN
      PERFORM pg_notify('${CHANNEL}', json_build_object('id', NEW.id, 'tc', NEW.t_create, 'content', NEW.content)::text);
      RETURN NEW;
    END; $f$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS trg_bench_notify ON bench_messages;
    CREATE TRIGGER trg_bench_notify AFTER INSERT ON bench_messages
      FOR EACH ROW EXECUTE FUNCTION bench_notify();`);
  await listener.connect();
  await listener.query(`LISTEN ${CHANNEL}`);
  listener.on('notification', onNotify);
  listener.on('error', (e) => { console.error('[listener]', e.message); process.exit(1); });
}

// ---------- fan-out ----------
function gaussian() { // Box-Muller
  return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
}

function onNotify(n) {
  const tb = now();
  counters.notify++;
  const p = JSON.parse(n.payload);
  p.seq = ++seq;
  p.tb = tb;
  const str = JSON.stringify(p); // serialize 1 lần
  buf.push(str);
  if (buf.length > 50000) { buf = buf.slice(10000); bufStart += 10000; }

  if (sseClients.size) {
    const frame = `data: ${str}\n\n`;
    for (const r of sseClients) { r.write(frame); counters.sseWrite++; }
  }
  if (wss && wss.clients.size) {
    for (const c of wss.clients) if (c.readyState === WebSocket.OPEN) { c.send(str); counters.wsSend++; }
  }
  if (pushClients.size) {
    // EMULATED provider: độ trễ log-normal (median, sigma) thay vì uniform 50-150ms
    const delay = Math.min(2000, PUSH_MEDIAN_MS * Math.exp(PUSH_SIGMA * gaussian()));
    setTimeout(() => {
      const frame = `data: ${str.slice(0, -1)},"tp":${now()}}\n\n`;
      for (const r of pushClients) { r.write(frame); counters.pushSend++; }
    }, delay);
  }
}

// ---------- HTTP ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => (s += c));
    req.on('end', () => { try { resolve(s ? JSON.parse(s) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const sseHead = (res) => {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.write('\n');
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /health': return json(res, 200, { ok: true, pid: process.pid });
      case 'GET /stats': return json(res, 200, stats());
      case 'POST /reset': {
        await pool.query('TRUNCATE bench_messages RESTART IDENTITY');
        seq = 0; buf = []; bufStart = 1;
        for (const k of Object.keys(counters)) counters[k] = 0;
        gcMs = 0; eld.reset();
        return json(res, 200, { ok: true });
      }
      case 'POST /messages': {
        const tc = now(); // thời điểm tạo message (trước INSERT)
        const body = await readBody(req);
        const r = await pool.query(
          'INSERT INTO bench_messages(content, t_create) VALUES ($1, $2) RETURNING id',
          [String(body.content || ''), tc]);
        return json(res, 201, { id: +r.rows[0].id, tc });
      }
      case 'GET /poll': {
        counters.pollReq++;
        if (url.searchParams.has('init')) return json(res, 200, { last: seq, items: [] });
        const after = +url.searchParams.get('after') || 0; // cursor theo seq
        const from = Math.max(0, after + 1 - bufStart);
        const items = from < buf.length ? buf.slice(from) : [];
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(`{"last":${seq},"items":[${items.join(',')}]}`);
      }
      case 'GET /sse': {
        sseHead(res); sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
      }
      case 'GET /push': { // kênh push MÔ PHỎNG (emulated provider)
        sseHead(res); pushClients.add(res);
        req.on('close', () => pushClients.delete(res));
        return;
      }
      default: return json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    counters.insertErr++;
    console.error('[http]', e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});
server.keepAliveTimeout = 65000;

server.on('error', (e) => { console.error('[server] lỗi listen:', e.code || e.message); process.exit(1); });
wss = new WebSocket.Server({ server, path: '/ws' });
wss.on('error', () => {});

initDb().then(() => server.listen(PORT, '127.0.0.1', () => console.log(`[bench2] listening ${PORT}`)))
  .catch((e) => { console.error('init failed:', e.message); process.exit(1); });

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
