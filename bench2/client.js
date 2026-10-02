'use strict';
/**
 * bench2/client.js - 1 tiến trình worker giữ một nhóm client.
 * Ghi MỖI lần nhận message thành 1 bản ghi nhị phân (5 x float64 = 40 byte):
 *   [clientId, msgId, tc, tb, tr]
 *     tc = lúc tạo message, tb = lúc bus server nhận NOTIFY, tr = lúc client nhận
 * Cấu hình qua biến môi trường CFG (JSON): {mech, base, n, id0, pollMs, out}
 * Mỗi kết nối có timeout (CONNECT_TIMEOUT_MS): kết nối treo => tính là failed, không làm kẹt cả worker.
 */
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const { monitorEventLoopDelay, performance } = require('perf_hooks');

const cfg = JSON.parse(process.env.CFG);
const CONNECT_TIMEOUT_MS = 15000;
const now = () => Number(process.hrtime.bigint()) / 1e6; // ms; hrtime cùng gốc cho MỌI tiến trình trên cùng máy (không lệch như timeOrigin)
const agent = new http.Agent({ keepAlive: true, maxSockets: Infinity });

const out = fs.createWriteStream(cfg.out);
const REC = 5, CHUNK = 4096;
let cur = new Float64Array(REC * CHUNK), pos = 0;
let connected = 0, failed = 0, timedOut = 0, errors = 0, records = 0;
const firstErrors = [];
const noteErr = (where, e) => { if (firstErrors.length < 5) firstErrors.push(`${where}: ${e && (e.code || e.message)}`); };

function rec(client, m, tr) {
  cur[pos++] = client; cur[pos++] = m.id; cur[pos++] = m.tc; cur[pos++] = m.tb; cur[pos++] = tr;
  records++;
  if (pos === cur.length) flush();
}
function flush() {
  if (pos === 0) return;
  out.write(Buffer.from(cur.buffer, 0, pos * 8));
  cur = new Float64Array(REC * CHUNK); pos = 0;
}

const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();
const closers = [];

// ---- SSE / PUSH (đều là text/event-stream) ----
function connectSse(client, path) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, why, e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (ok) connected++; else { failed++; if (why === 'timeout') timedOut++; noteErr('sse ' + why, e); }
      resolve();
    };
    const req = http.get(cfg.base + path, { agent }, (res) => {
      done(true);
      let b = '';
      res.on('data', (chunk) => {
        const tr = now();
        b += chunk;
        const parts = b.split('\n\n');
        b = parts.pop();
        for (const p of parts) {
          if (!p.startsWith('data: ')) continue;
          try { rec(client, JSON.parse(p.slice(6)), tr); } catch { errors++; }
        }
      });
      res.on('error', () => {});
    });
    const timer = setTimeout(() => { done(false, 'timeout'); req.destroy(); }, CONNECT_TIMEOUT_MS);
    req.on('error', (e) => done(false, 'error', e));
    closers.push(() => req.destroy());
  });
}

function connectWs(client) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, why, e) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (ok) connected++; else { failed++; if (why === 'timeout') timedOut++; noteErr('ws ' + why, e); }
      resolve();
    };
    const ws = new WebSocket(cfg.base.replace(/^http/, 'ws') + '/ws');
    const timer = setTimeout(() => { done(false, 'timeout'); ws.terminate(); }, CONNECT_TIMEOUT_MS);
    ws.on('open', () => done(true));
    ws.on('message', (d) => {
      const tr = now();
      try { rec(client, JSON.parse(d.toString()), tr); } catch { errors++; }
    });
    ws.on('error', (e) => done(false, 'error', e));
    closers.push(() => ws.terminate());
  });
}

// ---- POLLING: cursor theo seq, lịch cố định, pha ngẫu nhiên, không bao giờ 2 request chồng nhau ----
function get(path) {
  return new Promise((resolve, reject) => {
    const r = http.get(cfg.base + path, { agent }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => resolve({ body: s, tr: now() }));
      res.on('error', reject);
    });
    r.setTimeout(CONNECT_TIMEOUT_MS, () => r.destroy(new Error('timeout')));
    r.on('error', reject);
  });
}

async function connectPoll(client) {
  let last;
  try { last = JSON.parse((await get('/poll?init=1')).body).last; connected++; }
  catch (e) { failed++; noteErr('poll init', e); return; }
  let stopped = false;
  closers.push(() => { stopped = true; });
  let next = now() + Math.random() * cfg.pollMs; // pha ngẫu nhiên trong [0, interval)
  (async function loop() {
    while (!stopped) {
      const wait = next - now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      if (stopped) return;
      try {
        const { body, tr } = await get(`/poll?after=${last}`);
        const d = JSON.parse(body);
        last = d.last;
        for (const m of d.items) rec(client, m, tr);
      } catch { errors++; }
      next += cfg.pollMs; // lịch cố định (không cộng dồn RTT)
      if (next < now()) next = now(); // nếu trễ quá 1 chu kỳ thì bỏ tick, không dồn request
    }
  })();
}

async function main() {
  const conn = { sse: (c) => connectSse(c, '/sse'), push: (c) => connectSse(c, '/push'), ws: connectWs, poll: connectPoll }[cfg.mech];
  if (!conn) throw new Error('mech?');
  // ramp-up: 50 kết nối / 100ms để không tràn accept backlog (4 worker chạy song song)
  for (let i = 0; i < cfg.n; i += 50) {
    const batch = [];
    for (let j = i; j < Math.min(i + 50, cfg.n); j++) batch.push(conn(cfg.id0 + j));
    await Promise.all(batch);
    await new Promise((r) => setTimeout(r, 100));
  }
  process.send({ type: 'ready', connected, failed, timedOut, firstErrors });
}

process.on('message', (msg) => {
  if (msg !== 'stop') return;
  flush();
  for (const c of closers) try { c(); } catch {}
  out.end(() => {
    process.send({ type: 'done', connected, failed, timedOut, errors, records, firstErrors,
      eldP50: Math.max(0, eld.percentile(50) / 1e6 - 10), eldP99: Math.max(0, eld.percentile(99) / 1e6 - 10), eldMax: Math.max(0, eld.max / 1e6 - 10) }, () => process.exit(0));
  });
});

// worker sập => báo cho runner biết lý do, không để runner chờ vô hạn
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => {
    try { process.send({ type: 'crash', message: String(e && e.stack || e) }, () => process.exit(1)); } catch { process.exit(1); }
  });
}
main().catch((e) => { try { process.send({ type: 'crash', message: String(e && e.stack || e) }, () => process.exit(1)); } catch { process.exit(1); } });
