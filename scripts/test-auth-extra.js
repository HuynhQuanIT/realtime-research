'use strict';
/**
 * Test tự động cho auth-extra.js (OTP email + Google). KHÔNG cần SMTP hay Google thật:
 * mail và bước xác minh Google được thay bằng bản giả. Dùng DB trong DATABASE_URL,
 * chỉ tạo/xoá dữ liệu có email dạng authtest-*@example.com.
 *
 *   node -r dotenv/config scripts/test-auth-extra.js
 */
const assert = require('assert');
const http = require('http');
const express = require('express');
const cookieParser = require('cookie-parser');
const { Client } = require('pg');

process.env.GOOGLE_CLIENT_ID = 'test-client-id';
const DATABASE_URL = process.env.DATABASE_URL || 'postgres://postgres:postgres@localhost:5433/notifybench';
const mountAuthExtras = require('../auth-extra');

const sent = [];
const mailer = { sendMail: async (m) => { sent.push(m); } };
let googlePayload = null;
const googleVerify = async () => { if (!googlePayload) throw new Error('token sai'); return googlePayload; };

let passed = 0;
async function t(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.error('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  const pg = new Client({ connectionString: DATABASE_URL });
  await pg.connect();
  await pg.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, username TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL,
    display_name TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';`);

  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  const setAuthCookie = (res, user) => res.cookie('nb_token', `uid-${user.id}`, { httpOnly: true });
  const extras = mountAuthExtras({ app, pgClient: pg, setAuthCookie, mailer, googleVerify });
  await extras.migrate();

  const server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = async (p, body) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => ({})), cookie: res.headers.get('set-cookie') };
  };
  const uniq = () => `authtest-${Date.now()}-${Math.floor(Math.random() * 1e6)}@example.com`;
  const lastCode = () => /\b(\d{6})\b/.exec(sent[sent.length - 1].text)[1];
  const skipCooldown = (email) => pg.query("UPDATE login_otps SET created_at = created_at - interval '2 minutes' WHERE email = $1", [email]);
  const cleanup = async () => {
    await pg.query("DELETE FROM users WHERE email LIKE 'authtest-%@example.com' OR username LIKE 'authtest-%'");
    await pg.query("DELETE FROM login_otps WHERE email LIKE 'authtest-%@example.com'");
  };
  await cleanup();

  console.log('Cấu hình / kiểm tra đầu vào');
  await t('GET /auth/config trả client id, không lộ bí mật', async () => {
    const j = await (await fetch(base + '/auth/config')).json();
    assert.strictEqual(j.googleClientId, 'test-client-id');
    assert.deepStrictEqual(Object.keys(j).sort(), ['emailOtp', 'googleClientId']);
  });
  await t('email sai định dạng bị từ chối (400)', async () => {
    for (const bad of ['', 'abc', 'a@b', '@x.com', 'a b@x.com', null, 123]) {
      assert.strictEqual((await post('/auth/otp/request', { email: bad })).status, 400, String(bad));
    }
  });

  console.log('Luồng OTP');
  const email = uniq();
  await t('yêu cầu mã: gửi mail 6 số, KHÔNG trả mã trong response', async () => {
    const r = await post('/auth/otp/request', { email: `  ${email.toUpperCase()}  ` });
    assert.strictEqual(r.status, 200);
    assert.ok(!JSON.stringify(r.body).match(/\d{6}/), 'response không được chứa mã');
    assert.strictEqual(sent.at(-1).to, email, 'email phải được chuẩn hoá chữ thường');
    assert.ok(/^\d{6}$/.test(lastCode()));
    assert.ok(sent.at(-1).subject.includes(lastCode()));
  });
  await t('DB chỉ lưu hash, không lưu mã gốc', async () => {
    const rows = (await pg.query('SELECT code_hash FROM login_otps WHERE email = $1', [email])).rows;
    assert.strictEqual(rows.length, 1);
    assert.ok(!rows[0].code_hash.includes(lastCode()) || rows[0].code_hash.length === 64);
    assert.strictEqual(rows[0].code_hash.length, 64);
  });
  await t('gửi lại ngay bị chặn 429 và có retryAfter', async () => {
    const r = await post('/auth/otp/request', { email });
    assert.strictEqual(r.status, 429);
    assert.ok(r.body.retryAfter > 0 && r.body.retryAfter <= 60);
  });
  await t('nhập sai: báo còn bao nhiêu lần, quá 5 lần thì khoá mã (kể cả nhập đúng sau đó)', async () => {
    const good = lastCode();
    const wrong = good === '000000' ? '111111' : '000000';
    for (let i = 1; i <= 4; i++) {
      const r = await post('/auth/otp/verify', { email, code: wrong });
      assert.strictEqual(r.status, 400);
      assert.ok(r.body.error.includes(`Còn ${5 - i} lần`), r.body.error);
    }
    const fifth = await post('/auth/otp/verify', { email, code: wrong });
    assert.ok(fifth.body.error.includes('quá nhiều'), fifth.body.error);
    const afterLock = await post('/auth/otp/verify', { email, code: good });
    assert.strictEqual(afterLock.status, 400, 'mã đã bị khoá phải không dùng được');
  });
  await t('yêu cầu mã mới -> nhập đúng -> đăng nhập, user được tạo (không mật khẩu)', async () => {
    await skipCooldown(email);
    assert.strictEqual((await post('/auth/otp/request', { email })).status, 200);
    const r = await post('/auth/otp/verify', { email, code: lastCode() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.cookie && r.cookie.includes('nb_token'));
    assert.strictEqual(r.body.username, email);
    const u = (await pg.query('SELECT * FROM users WHERE email = $1', [email])).rows[0];
    assert.strictEqual(u.password_hash, null);
    assert.strictEqual(u.auth_provider, 'email');
  });
  await t('mã đã dùng không dùng lại được', async () => {
    const r = await post('/auth/otp/verify', { email, code: lastCode() });
    assert.strictEqual(r.status, 400);
  });
  await t('mã mới vô hiệu mã cũ', async () => {
    const e2 = uniq();
    await post('/auth/otp/request', { email: e2 });
    const oldCode = lastCode();
    await skipCooldown(e2);
    await post('/auth/otp/request', { email: e2 });
    const newCode = lastCode();
    if (oldCode !== newCode) assert.strictEqual((await post('/auth/otp/verify', { email: e2, code: oldCode })).status, 400);
    assert.strictEqual((await post('/auth/otp/verify', { email: e2, code: newCode })).status, 200);
  });
  await t('mã hết hạn bị từ chối', async () => {
    const e3 = uniq();
    await post('/auth/otp/request', { email: e3 });
    await pg.query("UPDATE login_otps SET expires_at = now() - interval '1 second' WHERE email = $1", [e3]);
    assert.strictEqual((await post('/auth/otp/verify', { email: e3, code: lastCode() })).status, 400);
  });
  await t('mã đúng nhưng của email khác thì không đăng nhập được', async () => {
    const a = uniq(), b = uniq();
    await post('/auth/otp/request', { email: a });
    const codeA = lastCode();
    await post('/auth/otp/request', { email: b });
    assert.strictEqual((await post('/auth/otp/verify', { email: b, code: codeA })).status === 200, codeA === lastCode());
  });
  await t('định dạng mã sai (chữ, thiếu số) bị 400', async () => {
    for (const code of ['abcdef', '12345', '1234567', '', null]) {
      assert.strictEqual((await post('/auth/otp/verify', { email, code })).status, 400);
    }
  });
  await t('tối đa 5 mã / email / giờ', async () => {
    const e4 = uniq();
    for (let i = 0; i < 5; i++) { await skipCooldown(e4); assert.strictEqual((await post('/auth/otp/request', { email: e4 })).status, 200, 'lần ' + (i + 1)); }
    await skipCooldown(e4);
    assert.strictEqual((await post('/auth/otp/request', { email: e4 })).status, 429);
  });
  await t('gửi mail lỗi -> 502 và không để lại mã (không kích hoạt cooldown)', async () => {
    const e5 = uniq();
    const orig = mailer.sendMail;
    mailer.sendMail = async () => { throw new Error('smtp down'); };
    const r = await post('/auth/otp/request', { email: e5 });
    mailer.sendMail = orig;
    assert.strictEqual(r.status, 502);
    assert.strictEqual((await pg.query('SELECT 1 FROM login_otps WHERE email = $1', [e5])).rowCount, 0);
    assert.strictEqual((await post('/auth/otp/request', { email: e5 })).status, 200);
  });

  console.log('Google');
  const gmail = uniq();
  await t('ID token hợp lệ + email đã xác minh -> tạo tài khoản và đăng nhập', async () => {
    googlePayload = { sub: 'g-sub-1', email: gmail, email_verified: true, name: 'Nguyen Van A' };
    const r = await post('/auth/google', { credential: 'x'.repeat(40) });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.displayName, 'Nguyen Van A');
    const u = (await pg.query('SELECT * FROM users WHERE email = $1', [gmail])).rows[0];
    assert.strictEqual(u.google_sub, 'g-sub-1');
    assert.strictEqual(u.auth_provider, 'google');
  });
  await t('đăng nhập Google lần 2 vào đúng tài khoản cũ (không tạo trùng)', async () => {
    const r = await post('/auth/google', { credential: 'x'.repeat(40) });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await pg.query('SELECT 1 FROM users WHERE email = $1', [gmail])).rowCount, 1);
  });
  await t('cùng email: OTP vào đúng tài khoản Google (gộp tài khoản)', async () => {
    const before = (await pg.query('SELECT id FROM users WHERE email = $1', [gmail])).rows[0].id;
    await post('/auth/otp/request', { email: gmail });
    const r = await post('/auth/otp/verify', { email: gmail, code: lastCode() });
    assert.strictEqual(r.status, 200);
    assert.strictEqual((await pg.query('SELECT id FROM users WHERE email = $1', [gmail])).rows[0].id, before);
    assert.strictEqual((await pg.query('SELECT COUNT(*)::int n FROM users WHERE email = $1', [gmail])).rows[0].n, 1);
  });
  await t('tài khoản OTP có trước, sau đó đăng nhập Google cùng email -> gộp, gắn google_sub', async () => {
    const e = uniq();
    await post('/auth/otp/request', { email: e });
    const r1 = await post('/auth/otp/verify', { email: e, code: lastCode() });
    const id = (await pg.query('SELECT id FROM users WHERE email = $1', [e])).rows[0].id;
    googlePayload = { sub: 'g-sub-2', email: e, email_verified: true, name: 'B' };
    const r2 = await post('/auth/google', { credential: 'y'.repeat(40) });
    assert.strictEqual(r1.status, 200); assert.strictEqual(r2.status, 200);
    const u = (await pg.query('SELECT * FROM users WHERE email = $1', [e])).rows[0];
    assert.strictEqual(u.id, id);
    assert.strictEqual(u.google_sub, 'g-sub-2');
  });
  await t('email Google CHƯA xác minh bị từ chối (401)', async () => {
    googlePayload = { sub: 'g-sub-3', email: uniq(), email_verified: false };
    assert.strictEqual((await post('/auth/google', { credential: 'z'.repeat(40) })).status, 401);
  });
  await t('token Google sai chữ ký/hết hạn (verify ném lỗi) -> 401', async () => {
    googlePayload = null;
    assert.strictEqual((await post('/auth/google', { credential: 'z'.repeat(40) })).status, 401);
  });
  await t('thiếu/sai kiểu credential -> 400', async () => {
    for (const c of [undefined, '', 'short', 123, 'a'.repeat(5000)]) {
      assert.strictEqual((await post('/auth/google', { credential: c })).status, 400);
    }
  });

  console.log('Tranh chấp username');
  await t('username đã bị đăng ký bằng mật khẩu trùng email -> vẫn tạo được (thêm hậu tố), không chiếm tài khoản cũ', async () => {
    const e = uniq();
    await pg.query("INSERT INTO users(username, password_hash, display_name) VALUES ($1, 'x', 'squatter')", [e]);
    await post('/auth/otp/request', { email: e });
    const r = await post('/auth/otp/verify', { email: e, code: lastCode() });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.username.startsWith(e + '#'), r.body.username);
    assert.strictEqual((await pg.query('SELECT display_name FROM users WHERE username = $1', [e])).rows[0].display_name, 'squatter');
  });

  await cleanup();
  server.close();
  await pg.end();
  console.log(`\n${passed} test đạt${process.exitCode ? ', CÓ LỖI' : ', tất cả OK'}`);
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
