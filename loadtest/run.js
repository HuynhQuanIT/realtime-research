/**
 * Load test đơn giản, không phụ thuộc thư viện ngoài (chỉ cần "ws").
 *
 * Cách dùng:
 *   node loadtest/run.js <poll|sse|ws> <so_client> <thoi_gian_giay> [poll_interval_ms]
 *
 * Ví dụ:
 *   node loadtest/run.js ws 1000 30
 *   node loadtest/run.js poll 1000 30 2000
 *
 * Trong lúc chạy, script sẽ:
 *  - Mở song song N kết nối theo phương pháp được chọn
 *  - Liên tục POST /messages với nhịp cố định để tạo sự kiện
 *  - Với mỗi message client nhận được, tính latency = (t_nhận - created_at)
 *  - Mỗi giây gọi GET /metrics để lấy RSS/CPU của server
 *  - Kết thúc: in thống kê avg/p50/p95/p99 latency + resource trung bình
 *  - Ghi toàn bộ kết quả ra loadtest/results/<method>-<clients>.csv
 */

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const http = require('http');

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';
const WS_URL = BASE_URL.replace(/^http/, 'ws') + '/ws';

const [, , method, clientsArg, durationArg, intervalArg] = process.argv;
const CLIENTS = parseInt(clientsArg || '100', 10);
const DURATION_MS = parseInt(durationArg || '30', 10) * 1000;
const POLL_INTERVAL_MS = parseInt(intervalArg || '2000', 10);
const MESSAGE_RATE_MS = 1000; // tạo 1 message mới mỗi giây trong suốt bài test

if (!['poll', 'sse', 'ws', 'fcm'].includes(method)) {
  console.error('Usage: node loadtest/run.js <poll|sse|ws|fcm> <clients> <durationSeconds> [pollIntervalMs]');
  process.exit(1);
}

const latencies = [];
const metricsSamples = [];
let connectedClients = 0;
let failedClients = 0;

function recordLatency(createdAt) {
  const latency = Date.now() - new Date(createdAt).getTime();
  if (latency >= 0) latencies.push(latency);
}

// ---------------- Sinh message liên tục trong lúc test ----------------
let msgCounter = 0;
function startMessageGenerator() {
  return setInterval(async () => {
    msgCounter += 1;
    try {
      await fetch(`${BASE_URL}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `benchmark-msg-${msgCounter}` }),
      });
    } catch (err) {
      console.error('[gen] insert failed:', err.message);
    }
  }, MESSAGE_RATE_MS);
}

// ---------------- Sample /metrics mỗi giây ----------------
function startMetricsSampler() {
  return setInterval(async () => {
    try {
      const res = await fetch(`${BASE_URL}/metrics`);
      const data = await res.json();
      metricsSamples.push(data);
    } catch (err) {
      // bỏ qua lỗi sample lẻ tẻ
    }
  }, 1000);
}

// ---------------- Kết nối client theo từng phương pháp ----------------

function connectWs() {
  const ws = new WebSocket(WS_URL);
  ws.on('open', () => (connectedClients += 1));
  ws.on('message', (data) => {
    try {
      const payload = JSON.parse(data.toString());
      recordLatency(payload.created_at);
    } catch {}
  });
  ws.on('error', () => (failedClients += 1));
  return ws;
}

function connectSse() {
  // Node không có EventSource built-in -> đọc raw stream bằng http
  const url = new URL(`${BASE_URL}/sse`);
  const req = http.get(url, (res) => {
    connectedClients += 1;
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop(); // phần chưa đủ 1 event, giữ lại
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          recordLatency(payload.created_at);
        } catch {}
      }
    });
  });
  req.on('error', () => (failedClients += 1));
  return req;
}

function connectFcm() {
  const token = `bench-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  // Đăng ký token trước, không chờ kết quả để không chặn việc mở stream
  fetch(`${BASE_URL}/fcm/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => {});

  // Nhận PUSH thật qua /fcm/stream (SSE), giống cách đo SSE/WS — không còn
  // client tự polling /fcm/sent, nên latency đo được phản ánh đúng chi phí
  // round-trip mô phỏng phía server (50-150ms), không bị cộng thêm chu kỳ poll.
  const url = new URL(`${BASE_URL}/fcm/stream`);
  const req = http.get(url, (res) => {
    connectedClients += 1;
    let buffer = '';
    res.on('data', (chunk) => {
      buffer += chunk.toString();
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        const line = part.split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        try {
          const payload = JSON.parse(line.slice(6));
          recordLatency(payload.created_at);
        } catch {}
      }
    });
  });
  req.on('error', () => (failedClients += 1));
  return req;
}

function startPollLoop() {
  let since = new Date().toISOString();
  connectedClients += 1;
  const timer = setInterval(async () => {
    try {
      const res = await fetch(`${BASE_URL}/poll?since=${encodeURIComponent(since)}`);
      const data = await res.json();
      since = data.serverTime;
      for (const item of data.items) recordLatency(item.created_at);
    } catch {
      failedClients += 1;
    }
  }, POLL_INTERVAL_MS);
  return timer;
}

// ---------------- Chạy test ----------------
async function main() {
  console.log(`\n=== Bench: method=${method} clients=${CLIENTS} duration=${DURATION_MS / 1000}s ===`);

  const handles = [];
  for (let i = 0; i < CLIENTS; i += 1) {
    if (method === 'ws') handles.push(connectWs());
    else if (method === 'sse') handles.push(connectSse());
    else if (method === 'poll') handles.push(startPollLoop());
    else if (method === 'fcm') handles.push(connectFcm());
  }

  const genTimer = startMessageGenerator();
  const metricsTimer = startMetricsSampler();

  await new Promise((r) => setTimeout(r, DURATION_MS));

  clearInterval(genTimer);
  clearInterval(metricsTimer);

  // đóng kết nối
  for (const h of handles) {
    if (method === 'ws') h.terminate();
    else if (method === 'sse' || method === 'fcm') h.destroy();
    else clearInterval(h); // chỉ còn poll dùng setInterval
  }

  printAndSaveResults();
}

function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function printAndSaveResults() {
  const avg = latencies.length ? latencies.reduce((a, b) => a + b, 0) / latencies.length : 0;
  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const p99 = percentile(latencies, 99);
  const max = latencies.length ? Math.max(...latencies) : 0;

  const avgRss = metricsSamples.length
    ? metricsSamples.reduce((a, b) => a + b.rssMB, 0) / metricsSamples.length
    : 0;
  const maxRss = metricsSamples.length ? Math.max(...metricsSamples.map((m) => m.rssMB)) : 0;
  const avgCpu = metricsSamples.length
    ? (metricsSamples[metricsSamples.length - 1].cpuUserMs -
        (metricsSamples[0]?.cpuUserMs || 0)) /
      (metricsSamples.length || 1)
    : 0;

  console.log('--- Kết quả ---');
  console.log(`Clients kết nối thành công: ${connectedClients} (lỗi: ${failedClients})`);
  console.log(`Số message nhận được (mẫu latency): ${latencies.length}`);
  console.log(`Latency (ms)  avg=${avg.toFixed(1)}  p50=${p50}  p95=${p95}  p99=${p99}  max=${max}`);
  console.log(`RAM server (MB)  avg=${avgRss.toFixed(1)}  max=${maxRss.toFixed(1)}`);
  console.log(`CPU user tăng trung bình mỗi lần sample (ms): ${avgCpu.toFixed(2)}`);

  const resultsDir = path.join(__dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const summaryPath = path.join(resultsDir, `${method}-${CLIENTS}.summary.json`);
  fs.writeFileSync(
    summaryPath,
    JSON.stringify(
      {
        method,
        clients: CLIENTS,
        durationSec: DURATION_MS / 1000,
        connectedClients,
        failedClients,
        samples: latencies.length,
        latencyMs: { avg, p50, p95, p99, max },
        ramMB: { avg: avgRss, max: maxRss },
        cpuUserMsPerSample: avgCpu,
      },
      null,
      2
    )
  );
  console.log(`Đã lưu: ${summaryPath}\n`);
}

main();
