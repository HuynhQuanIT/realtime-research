// Script dùng 1 lần: xoá sạch bảng users để đăng ký lại thành admin.
// Chạy: node reset-admin.js
// (Không ảnh hưởng lịch sử chat — bảng messages độc lập với bảng users.)
require('dotenv').config();
const { Client } = require('pg');

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/notifybench';

async function main() {
  const client = new Client({ connectionString: DATABASE_URL });
  await client.connect();

  const before = await client.query('SELECT id, username, role FROM users ORDER BY id ASC');
  console.log('Tài khoản hiện có:', before.rows);

  await client.query('DELETE FROM users');
  console.log('Đã xoá sạch bảng users. Đăng ký tài khoản mới trên localhost:3000 sẽ tự động thành admin.');

  await client.end();
}

main().catch((err) => {
  console.error('Lỗi:', err.message);
  process.exit(1);
});