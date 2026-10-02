'use strict';
/**
 * auth-extra.js - Đăng nhập bằng Google + đăng nhập bằng email OTP.
 *
 * Gắn vào server.js:
 *   const authExtras = require('./auth-extra')({ app, pgClient, setAuthCookie });
 *   ... trong initPg():  await authExtras.migrate();
 *
 * Endpoint:
 *   GET  /auth/config        -> { googleClientId, emailOtp }   (không chứa bí mật)
 *   POST /auth/otp/request   { email }          gửi mã 6 số qua email
 *   POST /auth/otp/verify    { email, code }    đúng mã -> đăng nhập (cookie JWT như /auth/login)
 *   POST /auth/google        { credential }     ID token từ Google Identity Services
 *
 * Bảo mật chính:
 *  - Mã OTP chỉ lưu dạng HMAC-SHA256, không lưu mã gốc; sinh bằng crypto.randomInt
 *  - Hết hạn 5 phút, dùng 1 lần, tối đa 5 lần thử sai / mã, mã mới vô hiệu mã cũ
 *  - Giới hạn: gửi lại sau 60s, tối đa 5 mã/email/giờ, giới hạn theo IP
 *  - Không bao giờ trả mã OTP trong response; không lộ email đã có tài khoản hay chưa
 *  - Google: server tự xác minh chữ ký + audience + hạn của ID token, bắt buộc email_verified
 *  - Tài khoản được gộp theo email đã xác minh (OTP và Google cùng email = cùng 1 tài khoản)
 */
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { OAuth2Client } = require('google-auth-library');

const OTP_LEN = 6;
const OTP_TTL_S = 5 * 60;
const RESEND_COOLDOWN_S = 60;
const MAX_ATTEMPTS = 5;
const MAX_CODES_PER_EMAIL_PER_HOUR = 5;

const MIGRATION_SQL = `
  ALTER TABLE users ALTER COLUMN password_hash DROP NOT NULL;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS google_sub TEXT;
  ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password';
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_uq ON users (lower(email)) WHERE email IS NOT NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS users_google_sub_uq ON users (google_sub) WHERE google_sub IS NOT NULL;
  CREATE TABLE IF NOT EXISTS login_otps (
    id BIGSERIAL PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INT NOT NULL DEFAULT 0,
    consumed BOOLEAN NOT NULL DEFAULT false,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
  );
  CREATE INDEX IF NOT EXISTS login_otps_email_idx ON login_otps (email, id DESC);
`;

module.exports = function mountAuthExtras({ app, pgClient, setAuthCookie, mailer, googleVerify }) {
  const env = process.env;
  const GOOGLE_CLIENT_ID = env.GOOGLE_CLIENT_ID || '';
  const OTP_SECRET = env.OTP_SECRET || env.JWT_SECRET || 'notify-benchmark-dev-secret-doi-neu-deploy-that';
  const isProd = env.NODE_ENV === 'production';

  // ---------- gửi mail ----------
  let transport = mailer || null;
  function getTransport() {
    if (transport) return transport;
    if (!env.SMTP_HOST) return null;
    const port = +env.SMTP_PORT || 587;
    transport = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port,
      secure: env.SMTP_SECURE === '1' || port === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
    return transport;
  }

  async function sendOtpMail(email, code) {
    const t = getTransport();
    if (!t) {
      if (isProd) throw new Error('SMTP chưa được cấu hình');
      // Chỉ ở chế độ phát triển: in mã ra console để thử khi chưa có SMTP.
      console.warn(`[otp][DEV] SMTP chưa cấu hình, mã OTP cho ${email}: ${code}`);
      return;
    }
    const mins = Math.round(OTP_TTL_S / 60);
    await t.sendMail({
      from: env.MAIL_FROM || env.SMTP_USER,
      to: email,
      subject: `${code} là mã đăng nhập notify-benchmark của bạn`,
      text:
        `Mã đăng nhập của bạn: ${code}\n\n` +
        `Mã có hiệu lực trong ${mins} phút và chỉ dùng được một lần.\n` +
        `Nếu bạn không yêu cầu mã này, hãy bỏ qua email. Không chia sẻ mã cho bất kỳ ai.`,
      html:
        `<div style="font-family:Arial,sans-serif;max-width:420px;margin:auto;padding:24px;border:1px solid #e8e9ed;border-radius:12px">` +
        `<p style="margin:0 0 12px;color:#333">Mã đăng nhập notify-benchmark của bạn:</p>` +
        `<p style="font-size:32px;font-weight:700;letter-spacing:8px;margin:0 0 16px;color:#0b0b0c">${code}</p>` +
        `<p style="margin:0;color:#70737c;font-size:13px;line-height:1.5">Mã có hiệu lực trong ${mins} phút và chỉ dùng được một lần.<br>` +
        `Nếu bạn không yêu cầu, hãy bỏ qua email này. Không chia sẻ mã cho bất kỳ ai.</p></div>`,
    });
  }

  // ---------- tiện ích ----------
  function normalizeEmail(raw) {
    if (typeof raw !== 'string') return null;
    const e = raw.trim().toLowerCase();
    if (e.length < 5 || e.length > 254) return null;
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : null;
  }
  const hashCode = (email, code) =>
    crypto.createHmac('sha256', OTP_SECRET).update(`${email}:${code}`).digest('hex');
  function safeEqualHex(a, b) {
    const x = Buffer.from(a, 'hex'), y = Buffer.from(b, 'hex');
    return x.length === y.length && crypto.timingSafeEqual(x, y);
  }
  const publicUser = (u) => ({ username: u.username, displayName: u.display_name, role: u.role });

  // giới hạn tốc độ theo khoá (IP...) trong bộ nhớ
  const buckets = new Map();
  function allow(key, max, windowMs) {
    const now = Date.now();
    const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
    if (arr.length >= max) { buckets.set(key, arr); return false; }
    arr.push(now);
    buckets.set(key, arr);
    return true;
  }
  setInterval(() => {
    const now = Date.now();
    for (const [k, arr] of buckets) if (!arr.length || now - arr[arr.length - 1] > 3600e3) buckets.delete(k);
  }, 600e3).unref();

  // ---------- tìm hoặc tạo user theo email / google ----------
  async function findOrCreateUser({ email, name, googleSub }) {
    const provider = googleSub ? 'google' : 'email';
    for (let round = 0; round < 3; round++) {
      if (googleSub) {
        const g = await pgClient.query('SELECT * FROM users WHERE google_sub = $1', [googleSub]);
        if (g.rows[0]) return g.rows[0];
      }
      const r = await pgClient.query('SELECT * FROM users WHERE lower(email) = $1', [email]);
      let user = r.rows[0];
      if (user) {
        if (googleSub && !user.google_sub) { // gộp tài khoản đã có (đăng nhập OTP trước đó) với Google
          const up = await pgClient.query(
            'UPDATE users SET google_sub = $1 WHERE id = $2 AND google_sub IS NULL RETURNING *', [googleSub, user.id]);
          user = up.rows[0] || user;
        }
        return user;
      }
      // Người đầu tiên của hệ thống là admin (giống /auth/register)
      const cnt = await pgClient.query('SELECT COUNT(*)::int AS n FROM users');
      const role = cnt.rows[0].n === 0 ? 'admin' : 'user';
      const display = String(name || email.split('@')[0]).trim().slice(0, 60);
      // username = email; nếu đã có ai đăng ký username này bằng mật khẩu thì thêm hậu tố
      for (const username of [email, `${email}#${crypto.randomBytes(3).toString('hex')}`]) {
        try {
          const ins = await pgClient.query(
            `INSERT INTO users(username, password_hash, display_name, role, email, google_sub, auth_provider)
             VALUES ($1, NULL, $2, $3, $4, $5, $6) RETURNING *`,
            [username, display, role, email, googleSub || null, provider]);
          return ins.rows[0];
        } catch (err) {
          if (err.code !== '23505') throw err;
          if (err.constraint !== 'users_username_key') break; // trùng email/google_sub: người khác vừa tạo -> SELECT lại
        }
      }
    }
    throw new Error('Không tạo được tài khoản');
  }

  // ---------- Google ----------
  const googleClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
  async function verifyGoogle(credential) {
    if (googleVerify) return googleVerify(credential);
    const ticket = await googleClient.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID });
    return ticket.getPayload();
  }

  // ---------- routes ----------
  app.get('/auth/config', (req, res) => {
    res.json({ googleClientId: GOOGLE_CLIENT_ID || null, emailOtp: true });
  });

  app.post('/auth/otp/request', async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) return res.status(400).json({ error: 'Email không hợp lệ' });
    if (!allow(`otpreq:ip:${req.ip}`, 20, 3600e3)) {
      return res.status(429).json({ error: 'Bạn thử quá nhiều lần, vui lòng quay lại sau' });
    }
    try {
      const st = await pgClient.query(
        `SELECT COUNT(*)::int AS n,
                COALESCE(EXTRACT(EPOCH FROM (now() - MAX(created_at))), 1000000)::float AS since
           FROM login_otps WHERE email = $1 AND created_at > now() - interval '1 hour'`, [email]);
      const { n, since } = st.rows[0];
      if (since < RESEND_COOLDOWN_S) {
        const wait = Math.ceil(RESEND_COOLDOWN_S - since);
        return res.status(429).json({ error: `Vui lòng đợi ${wait} giây trước khi gửi lại mã`, retryAfter: wait });
      }
      if (n >= MAX_CODES_PER_EMAIL_PER_HOUR) {
        return res.status(429).json({ error: 'Email này đã yêu cầu quá nhiều mã, vui lòng thử lại sau 1 giờ' });
      }
      const code = String(crypto.randomInt(0, 10 ** OTP_LEN)).padStart(OTP_LEN, '0');
      await pgClient.query('UPDATE login_otps SET consumed = true WHERE email = $1 AND consumed = false', [email]);
      const ins = await pgClient.query(
        `INSERT INTO login_otps(email, code_hash, expires_at)
         VALUES ($1, $2, now() + make_interval(secs => $3::double precision)) RETURNING id`,
        [email, hashCode(email, code), OTP_TTL_S]);
      try {
        await sendOtpMail(email, code);
      } catch (err) {
        console.error('[otp] gửi mail lỗi:', err.message);
        await pgClient.query('DELETE FROM login_otps WHERE id = $1', [ins.rows[0].id]);
        return res.status(502).json({ error: 'Không gửi được email, vui lòng thử lại sau' });
      }
      res.json({ ok: true, expiresIn: OTP_TTL_S, resendIn: RESEND_COOLDOWN_S });
    } catch (err) {
      console.error('[otp/request] error:', err.message);
      res.status(500).json({ error: 'Không gửi được mã, vui lòng thử lại' });
    }
  });

  app.post('/auth/otp/verify', async (req, res) => {
    const email = normalizeEmail(req.body && req.body.email);
    const code = String((req.body && req.body.code) || '').replace(/\s/g, '');
    if (!email || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Email hoặc mã không hợp lệ' });
    if (!allow(`otpver:ip:${req.ip}`, 30, 15 * 60e3)) {
      return res.status(429).json({ error: 'Bạn thử quá nhiều lần, vui lòng quay lại sau' });
    }
    const bad = { error: 'Mã không đúng hoặc đã hết hạn' };
    try {
      const latest = await pgClient.query(
        `SELECT id FROM login_otps WHERE email = $1 AND consumed = false AND expires_at > now()
          ORDER BY id DESC LIMIT 1`, [email]);
      if (!latest.rows[0]) return res.status(400).json(bad);
      // Giữ chỗ 1 lần thử NGUYÊN TỬ trước khi so sánh: không thể thử quá MAX_ATTEMPTS lần dù gửi song song
      const reserved = await pgClient.query(
        `UPDATE login_otps SET attempts = attempts + 1
          WHERE id = $1 AND consumed = false AND attempts < $2 AND expires_at > now()
          RETURNING attempts, code_hash`, [latest.rows[0].id, MAX_ATTEMPTS]);
      const row = reserved.rows[0];
      if (!row) return res.status(400).json(bad);
      if (!safeEqualHex(row.code_hash, hashCode(email, code))) {
        const left = MAX_ATTEMPTS - row.attempts;
        if (left <= 0) await pgClient.query('UPDATE login_otps SET consumed = true WHERE id = $1', [latest.rows[0].id]);
        return res.status(400).json({
          error: left > 0 ? `Mã không đúng. Còn ${left} lần thử` : 'Nhập sai quá nhiều lần, hãy yêu cầu mã mới',
        });
      }
      const used = await pgClient.query(
        'UPDATE login_otps SET consumed = true WHERE id = $1 AND consumed = false RETURNING id', [latest.rows[0].id]);
      if (!used.rows[0]) return res.status(400).json(bad);
      const user = await findOrCreateUser({ email });
      setAuthCookie(res, user);
      res.json(publicUser(user));
    } catch (err) {
      console.error('[otp/verify] error:', err.message);
      res.status(500).json({ error: 'Đăng nhập thất bại, vui lòng thử lại' });
    }
  });

  app.post('/auth/google', async (req, res) => {
    if (!GOOGLE_CLIENT_ID && !googleVerify) {
      return res.status(503).json({ error: 'Đăng nhập Google chưa được cấu hình' });
    }
    const credential = req.body && req.body.credential;
    if (typeof credential !== 'string' || credential.length < 20 || credential.length > 4096) {
      return res.status(400).json({ error: 'Thiếu thông tin đăng nhập Google' });
    }
    if (!allow(`google:ip:${req.ip}`, 30, 15 * 60e3)) {
      return res.status(429).json({ error: 'Bạn thử quá nhiều lần, vui lòng quay lại sau' });
    }
    let payload;
    try {
      payload = await verifyGoogle(credential);
    } catch (err) {
      console.warn('[google] ID token không hợp lệ:', err.message);
      return res.status(401).json({ error: 'Đăng nhập Google thất bại' });
    }
    const email = normalizeEmail(payload && payload.email);
    const verified = payload && (payload.email_verified === true || payload.email_verified === 'true');
    if (!payload || !payload.sub || !email || !verified) {
      return res.status(401).json({ error: 'Tài khoản Google này chưa xác minh email' });
    }
    try {
      const user = await findOrCreateUser({ email, name: payload.name, googleSub: String(payload.sub) });
      setAuthCookie(res, user);
      res.json(publicUser(user));
    } catch (err) {
      console.error('[google] error:', err.message);
      res.status(500).json({ error: 'Đăng nhập thất bại, vui lòng thử lại' });
    }
  });

  return {
    async migrate() {
      await pgClient.query(MIGRATION_SQL);
      // dọn mã OTP cũ định kỳ
      const t = setInterval(() => {
        pgClient.query("DELETE FROM login_otps WHERE expires_at < now() - interval '1 day'").catch(() => {});
      }, 3600e3);
      t.unref();
    },
    findOrCreateUser, // để test
  };
};
