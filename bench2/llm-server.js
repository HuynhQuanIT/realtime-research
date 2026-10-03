'use strict';
/**
 * bench2/llm-server.js - server đo workload "LLM streaming" (không dùng Postgres).
 *
 * Mỗi PHIÊN (session) là một dòng token riêng của 1 người dùng, do "mock LLM" sinh:
 *   - độ trễ prefill (TTFT gốc) log-normal quanh TTFT_BASE ms
 *   - các token sau đó cách nhau ~1000/rate ms, log-normal (sigma 0.25) quanh trung bình
 *   - mỗi token có ts = thời điểm "đến hạn" theo lịch (không trôi), tp = lúc thực sự gửi.
 *     Độ trễ tính từ ts nên event loop bị nghẽn (token gửi trễ) vẫn được đo, không bị giấu.
 *
 * Ba cách giao token:
 *   GET  /llm/sse?sid&tokens&rate       SSE; HỦY = client đóng kết nối (server bắt sự kiện 'close')
 *   WS   /llm/ws   {type:start|cancel}  WebSocket 1 kết nối/client, HỦY = gửi message trong cùng kết nối
 *   POST /llm/start, GET /llm/poll      polling; HỦY = POST /llm/cancel
 *
 * Mock LLM => kết quả đặc trưng cho TẦNG TRUYỀN TẢI, không phải cho mô hình ngôn ngữ thật.
 */
const http = require('http');
const WebSocket = require('ws');
const { monitorEventLoopDelay, PerformanceObserver, performance } = require('perf_hooks');

const PORT = +process.env.PORT || 3100;
const TTFT_BASE_MS = +process.env.TTFT_BASE || 300;
const now = () => Number(process.hrtime.bigint()) / 1e6; // cùng gốc thời gian với mọi tiến trình cùng máy

const sessions = new Map(); // sid -> bản ghi (giữ lại cho /llm/report)
const counters = { tokens: 0, started: 0, finished: 0, cancelled: 0, pollReq: 0 };
let active = 0;

const eld = monitorEventLoopDelay({ resolution: 10 });
eld.enable();
let gcMs = 0;
new PerformanceObserver((list) => { for (const e of list.getEntries()) gcMs += e.duration; }).observe({ entryTypes: ['gc'] });
let lastElu = performance.eventLoopUtilization();
let wss;
const sseOpen = new Set();

function backlog() {
  let max = 0;
  for (const r of sseOpen) if (r.writableLength > max) max = r.writableLength;
  if (wss) for (const c of wss.clients) if (c.bufferedAmount > max) max = c.bufferedAmount;
  return max;
}
function stats() {
  const m = process.memoryUsage(), c = process.cpuUsage();
  const elu = performance.eventLoopUtilization(lastElu);
  lastElu = performance.eventLoopUtilization();
  const out = {
    t: now(), cpuUserUs: c.user, cpuSysUs: c.system, rssMB: m.rss / 1048576, heapMB: m.heapUsed / 1048576,
    eldP50: Math.max(0, eld.percentile(50) / 1e6 - 10), eldP99: Math.max(0, eld.percentile(99) / 1e6 - 10),
    eldMax: Math.max(0, eld.max / 1e6 - 10), elu: elu.utilization, gcMs, backlogBytes: backlog(),
    active, ...counters,
  };
  eld.reset();
  return out;
}

function gaussian() { return Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random()); }

/** Bắt đầu 1 phiên. sink(token) gửi token đi; onDone() gọi khi hết token. */
function startSession(sid, tokens, rate, sink, onDone) {
  if (sessions.has(sid)) return sessions.get(sid);
  const rec = { sid, startAt: now(), firstTokenAt: null, cancelProcessedAt: null, endedAt: null, reason: null, sent: 0, timer: null, buf: null };
  sessions.set(sid, rec);
  counters.started++; active++;
  const gapMean = 1000 / rate, SIGMA = 0.25;
  let i = 0;
  let due = rec.startAt + TTFT_BASE_MS * Math.exp(0.3 * gaussian()); // prefill
  rec.end = (reason) => {
    if (rec.reason) return;
    rec.reason = reason; rec.endedAt = now(); clearTimeout(rec.timer); active--;
    if (reason === 'done') { counters.finished++; if (onDone) onDone(); } else counters.cancelled++;
  };
  const tick = () => {
    rec.timer = null;
    if (rec.reason) return;
    const tp = now();
    if (i === 0) rec.firstTokenAt = tp;
    counters.tokens++; rec.sent++;
    sink({ sid, i, ts: Math.min(due, tp), tp }); // timer có thể nổ sớm <1ms: không để độ trễ âm; gửi trễ thì vẫn tính
    i++;
    if (i >= tokens) return rec.end('done');
    due += gapMean * Math.exp(SIGMA * gaussian() - (SIGMA * SIGMA) / 2); // trung bình = gapMean
    rec.timer = setTimeout(tick, Math.max(0, due - now()));
  };
  rec.timer = setTimeout(tick, Math.max(0, due - rec.startAt));
  return rec;
}
function cancelSession(sid) {
  const rec = sessions.get(sid);
  if (!rec || rec.reason) return false;
  rec.cancelProcessedAt = now(); // mốc server THỰC SỰ xử lý lệnh huỷ
  rec.end('cancelled');
  return true;
}

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const sid = +q.get('sid');
  try {
    switch (`${req.method} ${url.pathname}`) {
      case 'GET /health': return json(res, 200, { ok: true, pid: process.pid });
      case 'GET /stats': return json(res, 200, stats());
      case 'POST /reset':
        for (const r of sessions.values()) clearTimeout(r.timer);
        sessions.clear(); active = 0;
        for (const k of Object.keys(counters)) counters[k] = 0;
        gcMs = 0; eld.reset();
        return json(res, 200, { ok: true });
      case 'GET /llm/report':
        return json(res, 200, [...sessions.values()].map((r) => ({
          sid: r.sid, startAt: r.startAt, firstTokenAt: r.firstTokenAt, cancelProcessedAt: r.cancelProcessedAt,
          endedAt: r.endedAt, reason: r.reason, sent: r.sent })));
      case 'GET /llm/sse': {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        res.write('\n');
        sseOpen.add(res);
        const rec = startSession(sid, +q.get('tokens'), +q.get('rate'),
          (t) => res.write(`data: ${JSON.stringify(t)}\n\n`),
          () => { res.write(`data: ${JSON.stringify({ sid, done: true })}\n\n`); res.end(); });
        res.on('close', () => { // 'close' của response = kết nối bị đóng (hoặc đã kết thúc bình thường)
          sseOpen.delete(res);
          if (!rec.reason) { rec.cancelProcessedAt = now(); rec.end('cancelled'); } // huỷ bằng cách đóng kết nối
        });
        return;
      }
      case 'POST /llm/start': {
        const rec = startSession(sid, +q.get('tokens'), +q.get('rate'), (t) => { rec.buf.push(t); }, null);
        if (!rec.buf) rec.buf = [];
        return json(res, 200, { ok: true });
      }
      case 'GET /llm/poll': {
        counters.pollReq++;
        const rec = sessions.get(sid);
        if (!rec || !rec.buf) return json(res, 404, { error: 'no session' });
        const after = +q.get('after');
        const items = rec.buf.slice(after + 1);
        return json(res, 200, { items, done: rec.reason === 'done' });
      }
      case 'POST /llm/cancel':
        return json(res, 200, { ok: cancelSession(sid) });
      default: return json(res, 404, { error: 'not found' });
    }
  } catch (e) {
    console.error('[llm-http]', e.message);
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});
server.keepAliveTimeout = 65000;
server.on('error', (e) => { console.error('[server] lỗi listen:', e.code || e.message); process.exit(1); });

wss = new WebSocket.Server({ server, path: '/llm/ws' });
wss.on('error', () => {});
wss.on('connection', (ws) => {
  const mine = new Set();
  ws.on('message', (d) => {
    let m; try { m = JSON.parse(d.toString()); } catch { return; }
    if (m.type === 'start') {
      mine.add(m.sid);
      startSession(m.sid, m.tokens, m.rate,
        (t) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(t)); },
        () => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ sid: m.sid, done: true })); });
    } else if (m.type === 'cancel') cancelSession(m.sid);
  });
  ws.on('close', () => { for (const sid of mine) { const r = sessions.get(sid); if (r && !r.reason) r.end('disconnected'); } });
});

server.listen(PORT, '127.0.0.1', () => console.log(`[llm-server] listening ${PORT}`));
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => process.exit(0));
