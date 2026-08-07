#!/usr/bin/env node
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const METHODS = ['poll', 'sse', 'ws', 'fcm'];
const CLIENT_LEVELS = process.env.BENCH_CLIENTS
  ? process.env.BENCH_CLIENTS.split(',').map(Number)
  : [10, 50, 100, 500, 1000];
const DURATION = process.env.BENCH_DURATION ? parseInt(process.env.BENCH_DURATION, 10) : 20;

const rootDir = path.join(__dirname, '..');
const resultsDir = path.join(__dirname, 'results');
fs.mkdirSync(resultsDir, { recursive: true });

const stamp = new Date()
  .toISOString()
  .replace(/[-:]/g, '')
  .replace('T', '-')
  .slice(0, 15);
const csvPath = path.join(resultsDir, `summary-${stamp}.csv`);
const HEADER =
  'method,clients,duration_s,connected,failed,samples,latency_avg_ms,latency_p50_ms,latency_p95_ms,latency_p99_ms,latency_max_ms,ram_avg_mb,ram_max_mb,cpu_user_ms_per_sample';
fs.writeFileSync(csvPath, HEADER + '\n');

function sleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

for (const method of METHODS) {
  for (const clients of CLIENT_LEVELS) {
    console.log(`\n>>> Benchmarking: ${method} x ${clients} clients`);
    try {
      execFileSync(
        process.execPath,
        [path.join(__dirname, 'run.js'), method, String(clients), String(DURATION)],
        { cwd: rootDir, stdio: 'inherit' }
      );
    } catch (err) {
      console.error(`[bench-all] Lượt ${method} x ${clients} lỗi:`, err.message);
    }

    const summaryPath = path.join(resultsDir, `${method}-${clients}.summary.json`);
    if (fs.existsSync(summaryPath)) {
      try {
        const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        const row = [
          s.method,
          s.clients,
          s.durationSec,
          s.connectedClients,
          s.failedClients,
          s.samples,
          s.latencyMs?.avg ? s.latencyMs.avg.toFixed(1) : 0,
          s.latencyMs?.p50 ?? 0,
          s.latencyMs?.p95 ?? 0,
          s.latencyMs?.p99 ?? 0,
          s.latencyMs?.max ?? 0,
          s.ramMB?.avg ? s.ramMB.avg.toFixed(1) : 0,
          s.ramMB?.max ? s.ramMB.max.toFixed(1) : 0,
          s.cpuUserMsPerSample ? s.cpuUserMsPerSample.toFixed(2) : 0,
        ].join(',');
        fs.appendFileSync(csvPath, row + '\n');
      } catch (parseErr) {
        console.error(`Lỗi đọc file summary ${summaryPath}:`, parseErr.message);
      }
    }

    sleep(3000);
  }
}

console.log(`\n✅ Đã hoàn tất! Kết quả lưu tại: ${csvPath}`);