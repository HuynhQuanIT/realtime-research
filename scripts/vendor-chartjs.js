// Copy Chart.js UMD build vào public/vendor để dashboard không phụ thuộc CDN
// (mạng công ty/firewall chặn CDN sẽ làm biểu đồ báo "Chart is not defined").
const fs = require('fs');
const path = require('path');

const src = path.join(__dirname, '..', 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
const destDir = path.join(__dirname, '..', 'public', 'vendor');
const dest = path.join(destDir, 'chart.umd.js');

try {
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, dest);
  console.log('[vendor-chartjs] Đã copy chart.umd.js vào public/vendor/');
} catch (err) {
  console.warn('[vendor-chartjs] Không copy được chart.umd.js:', err.message);
  console.warn('[vendor-chartjs] Dashboard vẫn hoạt động nếu public/vendor/chart.umd.js đã có sẵn.');
}