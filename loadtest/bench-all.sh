#!/usr/bin/env node
/**
 * Bản Node.js thuần của bench-all.sh — chạy lần lượt poll/sse/ws/fcm qua các
 * mức tải, gom kết quả vào 1 CSV. Dùng bản này thay vì bench-all.sh trên
 * Windows/Git Bash nếu gặp lỗi "node: command not found" (bash không thấy
 * node trong PATH dù PowerShell chạy bình thường) — script này dùng
 * process.execPath nên luôn gọi đúng node.exe đang chạy nó, không phụ thuộc
 * PATH của shell.
 *
 * Cách dùng:
 *   node loadtest/bench-all.js
 *   (hoặc: npm run bench:all)
 *
 * Yêu cầu: server.js đang chạy sẵn ở BASE_URL (mặc định http://localhost:3000)
 * Sửa CLIENT_LEVELS / DURATION bên dưới nếu muốn đổi mức tải hoặc thời lượng.
 */

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const METHODS = ['poll', 'sse', 'ws', 'fcm'];
const CLIENT_LEVELS = [10, 50, 100, 500, 1000];
const DURATION = 20; // giây mỗi lượt test

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
  // Dùng 1 tiến trình node con để "ngủ" — chạy được trên mọi hệ điều hành,
  // không cần lệnh `sleep` (vốn không có sẵn trên Windows/cmd).
  execFileSync(process.execPath, ['-e', `setTimeout(()=>{}, ${ms})`]);
}

for (const method of METHODS) {
  for (const clients of CLIENT_LEVELS) {
    console.log(`>>> ${method} x ${clients} clients`);
    try {
      execFileSync(
        process.execPath,
        ['loadtest/run.js', method, String(clients), String(DURATION)],
        { cwd: rootDir, stdio: 'inherit' }
      );
    } catch (err) {
      console.error(`[bench-all] Lượt ${method} x ${clients} lỗi:`, err.message);
    }

    const summaryPath = path.join(resultsDir, `${method}-${clients}.summary.json`);
    if (fs.existsSync(summaryPath)) {
      const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      const row = [
        s.method,
        s.clients,
        s.durationSec,
        s.connectedClients,
        s.failedClients,
        s.samples,
        s.latencyMs.avg.toFixed(1),
        s.latencyMs.p50,
        s.latencyMs.p95,
        s.latencyMs.p99,
        s.latencyMs.max,
        s.ramMB.avg.toFixed(1),
        s.ramMB.max.toFixed(1),
        s.cpuUserMsPerSample.toFixed(2),
      ].join(',');
      fs.appendFileSync(csvPath, row + '\n');
    }

    sleep(3000); // cho server "nghỉ" giữa 2 lượt test, giống bench-all.sh
  }
}

console.log(`Xong. Kết quả tổng hợp: ${csvPath}`);