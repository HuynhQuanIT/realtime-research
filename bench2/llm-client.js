'use strict';
/**
 * bench2/llm-client.js - worker giữ một nhóm "người dùng" chạy các phiên stream token LIÊN TỤC.
 * Vòng đời mỗi người dùng:  [chờ ngẫu nhiên 0-2s] -> (mở phiên -> nhận token -> xong hoặc HUỶ) -> nghỉ 0.5-1s -> phiên kế
 * lặp cho tới hết cửa sổ đo (winEnd); phiên đã mở thì được chạy hết.
 *
 * Ghi nhị phân 5 x float64 / bản ghi: [clientId, sid, idx, ts, tr]
 *   idx >= 0 : token thứ idx; ts = thời điểm token "đến hạn" (đồng hồ server), tr = lúc client nhận
 *   idx = -1 : yêu cầu mở phiên      (tr = thời điểm gửi yêu cầu)
 *   idx = -2 : người dùng bấm HUỶ    (tr = thời điểm gọi huỷ)
 *   idx = -3 : nhận tín hiệu hoàn tất (tr = thời điểm nhận)
 * CFG (JSON): {mech: llm-sse|llm-ws|llm-poll, base, n, id0, pollMs, out, tokens, tokrate, cancelP, seed}
 */
const http = require('http');
const fs = require('fs');
const WebSocket = require('ws');
const { monitorEventLoopDelay } = require('perf_hooks');

const cfg = JSON.parse(process.env.CFG);
const now = () => Number(process.hrtime.bigint()) / 1e6;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TIMEOUT_MS = 15000;
const SESSION_MAX_MS = (cfg.tokens / cfg.tokrate) * 1000 * 3 + 20000;
const agentKeep = new http.Agent({ keepAlive: true, maxSockets: Infinity });   // poll / POST
const agentFresh = new http.Agent({ keepAlive: false, maxSockets: Infinity }); // SSE: mỗi phiên 1 kết nối mới

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let stopped = false;
const out = fs.createWriteStream(cfg.out);
const REC = 5, CHUNK = 4096;
let cur = new Float64Array(REC * CHUNK), pos = 0;
let connected = 0, failed = 0, errors = 0, records = 0, sessionsStarted = 0, sessionTimeouts = 0;
const firstErrors = [];
const noteErr = (w, e) => { if (firstErrors.length < 5) firstErrors.push(`${w}: ${e && (e.code || e.message)}`); };
function rec(client, sid, idx, ts, tr) {
  if (stopped) return; // sau lệnh dừng, bản ghi muộn bị bỏ (stream đã đóng)
  cur[pos++] = client; cur[pos++] = sid; cur[pos++] = idx; cur[pos++] = ts; cur[pos++] = tr;
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

// ---------- HTTP helpers ----------
function httpCall(method, path) {
  return new Promise((resolve, reject) => {
    const r = http.request(cfg.base + path, { method, agent: agentKeep }, (res) => {
      let s = '';
      res.on('data', (c) => (s += c));
      res.on('end', () => { try { resolve({ body: JSON.parse(s), tr: now() }); } catch (e) { reject(e); } });
      res.on('error', reject);
    });
    r.setTimeout(TIMEOUT_MS, () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

// ---------- SSE: huỷ = đóng kết nối ----------
function sseSession(client, sid, cancelAt) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(guard); resolve(); } };
    rec(client, sid, -1, 0, now());
    const req = http.get(`${cfg.base}/llm/sse?sid=${sid}&tokens=${cfg.tokens}&rate=${cfg.tokrate}`, { agent: agentFresh }, (res) => {
      let b = '';
      res.on('data', (chunk) => {
        if (settled) return;
        const tr = now();
        b += chunk;
        const parts = b.split('\n\n');
        b = parts.pop();
        for (const p of parts) {
          const ev = p.replace(/^\s+/, ''); // dòng trống đầu luồng SSE dính vào sự kiện đầu tiên
          if (!ev.startsWith('data: ')) continue;
          let m; try { m = JSON.parse(ev.slice(6)); } catch { errors++; continue; }
          if (m.done) { rec(client, sid, -3, 0, tr); finish(); return; }
          rec(client, sid, m.i, m.ts, tr);
          if (cancelAt && m.i + 1 === cancelAt) { rec(client, sid, -2, 0, now()); req.destroy(); finish(); return; }
        }
      });
      res.on('error', finish); res.on('end', finish); res.on('close', finish);
    });
    req.on('error', (e) => { if (!settled) { errors++; noteErr('sse', e); } finish(); });
    const guard = setTimeout(() => { sessionTimeouts++; req.destroy(); finish(); }, SESSION_MAX_MS);
  });
}

// ---------- WebSocket: 1 kết nối / client, huỷ = message trong cùng kết nối ----------
const wsState = new Map(); // client -> { ws, cur }
function connectLlmWs(client) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, e) => { if (settled) return; settled = true; clearTimeout(t); if (ok) connected++; else { failed++; noteErr('ws', e); } resolve(); };
    const ws = new WebSocket(cfg.base.replace(/^http/, 'ws') + '/llm/ws');
    const st = { ws, cur: null };
    wsState.set(client, st);
    const t = setTimeout(() => { done(false, new Error('timeout')); ws.terminate(); }, TIMEOUT_MS);
    ws.on('open', () => done(true));
    ws.on('message', (d) => {
      const tr = now();
      let m; try { m = JSON.parse(d.toString()); } catch { errors++; return; }
      const c = st.cur;
      if (c && m.sid === c.sid) c.onMsg(m, tr); // token muộn của phiên đã huỷ bị bỏ qua
    });
    ws.on('error', (e) => done(false, e));
    closers.push(() => ws.terminate());
  });
}
function wsSession(client, sid, cancelAt) {
  return new Promise((resolve) => {
    const st = wsState.get(client);
    if (!st || st.ws.readyState !== WebSocket.OPEN) { errors++; return resolve(); }
    let settled = false;
    const finish = () => { if (!settled) { settled = true; clearTimeout(guard); st.cur = null; resolve(); } };
    st.cur = { sid, onMsg: (m, tr) => {
      if (m.done) { rec(client, sid, -3, 0, tr); return finish(); }
      rec(client, sid, m.i, m.ts, tr);
      if (cancelAt && m.i + 1 === cancelAt) {
        rec(client, sid, -2, 0, now());
        st.ws.send(JSON.stringify({ type: 'cancel', sid }));
        finish();
      }
    } };
    rec(client, sid, -1, 0, now());
    st.ws.send(JSON.stringify({ type: 'start', sid, tokens: cfg.tokens, rate: cfg.tokrate }));
    const guard = setTimeout(() => { sessionTimeouts++; finish(); }, SESSION_MAX_MS);
  });
}

// ---------- Polling: lịch cố định, huỷ = POST /llm/cancel ----------
async function pollSession(client, sid, cancelAt) {
  rec(client, sid, -1, 0, now());
  try { await httpCall('POST', `/llm/start?sid=${sid}&tokens=${cfg.tokens}&rate=${cfg.tokrate}`); }
  catch (e) { errors++; noteErr('poll start', e); return; }
  const deadline = now() + SESSION_MAX_MS;
  let after = -1, next = now() + cfg.pollMs;
  while (!stopped && now() < deadline) {
    const wait = next - now();
    if (wait > 0) await sleep(wait);
    let d, tr;
    try { ({ body: d, tr } = await httpCall('GET', `/llm/poll?sid=${sid}&after=${after}`)); }
    catch (e) { errors++; noteErr('poll', e); next = now() + cfg.pollMs; continue; }
    for (const t of d.items || []) {
      rec(client, sid, t.i, t.ts, tr);
      if (t.i > after) after = t.i;
      if (cancelAt && t.i + 1 === cancelAt) {
        rec(client, sid, -2, 0, now());
        try { await httpCall('POST', `/llm/cancel?sid=${sid}`); } catch (e) { errors++; noteErr('poll cancel', e); }
        return;
      }
    }
    if (d.done && after + 1 >= cfg.tokens) { rec(client, sid, -3, 0, now()); return; }
    next += cfg.pollMs;
    if (next < now()) next = now();
  }
  sessionTimeouts++;
}

// ---------- vòng đời người dùng ----------
const sessionFn = { 'llm-sse': sseSession, 'llm-ws': wsSession, 'llm-poll': pollSession }[cfg.mech];
async function userLoop(client, winEnd) {
  const r = mulberry32(cfg.seed * 7919 + client);
  await sleep(r() * 2000);
  let k = 0;
  while (!stopped && now() < winEnd) {
    const sid = client * 100000 + (++k);
    const cancelAt = r() < cfg.cancelP ? Math.max(1, Math.floor(cfg.tokens * (0.2 + 0.5 * r()))) : 0;
    sessionsStarted++;
    await sessionFn(client, sid, cancelAt);
    await sleep(500 + r() * 500); // thời gian "suy nghĩ" giữa 2 phiên
  }
}

async function main() {
  if (!sessionFn) throw new Error('mech?');
  if (cfg.mech === 'llm-ws') {
    for (let i = 0; i < cfg.n; i += 50) {
      const batch = [];
      for (let j = i; j < Math.min(i + 50, cfg.n); j++) batch.push(connectLlmWs(cfg.id0 + j));
      await Promise.all(batch);
      await sleep(100);
    }
  } else connected = cfg.n; // SSE / poll không có pha kết nối trước
  process.send({ type: 'ready', connected, failed, timedOut: 0, firstErrors });
}

process.on('message', (msg) => {
  if (msg && msg.type === 'go') {
    for (let j = 0; j < cfg.n; j++) userLoop(cfg.id0 + j, msg.winEnd).catch((e) => { errors++; noteErr('user', e); });
    return;
  }
  if (msg !== 'stop') return;
  stopped = true;
  flush();
  for (const c of closers) try { c(); } catch {}
  out.end(() => {
    process.send({ type: 'done', connected, failed, timedOut: 0, errors, records, sessionsStarted, sessionTimeouts, firstErrors,
      eldP50: Math.max(0, eld.percentile(50) / 1e6 - 10), eldP99: Math.max(0, eld.percentile(99) / 1e6 - 10), eldMax: Math.max(0, eld.max / 1e6 - 10) },
      () => process.exit(0));
  });
});
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => { try { process.send({ type: 'crash', message: String((e && e.stack) || e) }, () => process.exit(1)); } catch { process.exit(1); } });
}
main().catch((e) => { try { process.send({ type: 'crash', message: String((e && e.stack) || e) }, () => process.exit(1)); } catch { process.exit(1); } });
