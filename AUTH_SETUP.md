# Đăng nhập bằng Google và email OTP

Hệ thống có 4 cách đăng nhập, dùng chung một tài khoản nếu cùng email:

| Cách | Cần cấu hình |
|---|---|
| Google | `GOOGLE_CLIENT_ID` |
| Email + mã OTP | SMTP (hoặc để trống khi thử: mã in ra console server) |
| Username + mật khẩu (có sẵn) | không |
| Tạo tài khoản bằng username (có sẵn) | không |

Người dùng đăng nhập bằng email hoặc Google có `username` = địa chỉ email. Tài khoản cùng email được gộp:
đăng nhập OTP rồi sau đó đăng nhập Google (hoặc ngược lại) vào đúng một tài khoản.

## 1. Cài đặt

```
npm install
copy .env.example .env      (Windows)   hoặc   cp .env.example .env
```

Mở `.env`, điền các giá trị bên dưới. Tạo khoá bí mật:

```
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Chạy lệnh trên hai lần, dán vào `JWT_SECRET` và `OTP_SECRET`. Sau đó `npm start`.
Lần khởi động đầu server tự thêm cột `email`, `google_sub` vào bảng `users` và tạo bảng `login_otps`
(tài khoản cũ không bị ảnh hưởng).

## 2. Thử nhanh không cần cấu hình gì (chế độ phát triển)

Để trống `SMTP_HOST`. Vào tab **Email**, nhập email, bấm **Gửi mã**. Mã 6 số được in ra
cửa sổ terminal đang chạy server, dòng có chữ `[otp][DEV]`. Nhập mã đó để đăng nhập.
Khi `NODE_ENV=production` mà chưa có SMTP thì server từ chối gửi mã, không bao giờ in mã ra.

## 3. Gửi email thật bằng Gmail

1. Bật **Xác minh 2 bước** cho tài khoản Google: myaccount.google.com/security
2. Tạo **Mật khẩu ứng dụng**: myaccount.google.com/apppasswords, đặt tên bất kỳ, copy chuỗi 16 ký tự (bỏ dấu cách).
3. Điền `.env`:

```
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=0
SMTP_USER=ban@gmail.com
SMTP_PASS=abcdefghijklmnop
MAIL_FROM="Notify Bench <ban@gmail.com>"
```

Gmail giới hạn khoảng 500 email mỗi ngày và hay vào thư mục Spam. Khi chạy thật cho nhiều người,
dùng dịch vụ gửi mail giao dịch (Resend, SendGrid, Brevo, Amazon SES...); chỉ cần đổi 5 biến SMTP ở trên.

## 4. Đăng nhập bằng Google

1. Vào console.cloud.google.com, tạo hoặc chọn một project.
2. **APIs & Services > OAuth consent screen**: chọn *External*, điền tên ứng dụng và email hỗ trợ, lưu.
   Khi còn ở trạng thái *Testing*, chỉ các email thêm trong mục **Test users** mới đăng nhập được.
   Bấm **Publish app** để mở cho mọi người (chỉ dùng quyền cơ bản email và profile nên không cần Google xét duyệt).
3. **APIs & Services > Credentials > Create credentials > OAuth client ID**, loại **Web application**.
4. Ở **Authorized JavaScript origins** thêm đúng địa chỉ bạn mở trang, ví dụ `http://localhost:3000`
   (và tên miền thật nếu có). `localhost` và `127.0.0.1` là hai origin khác nhau. Không cần điền redirect URI.
5. Copy **Client ID** (đuôi `.apps.googleusercontent.com`) vào `GOOGLE_CLIENT_ID` trong `.env`. Không cần Client secret.
6. Khởi động lại server. Trang đăng nhập sẽ hiện nút Google ở trên cùng.

Server tự xác minh chữ ký, hạn dùng, `audience` của token Google và bắt buộc email đã được Google xác minh.

## 5. Chạy kiểm thử

```
npm run test:auth
```

Test dùng email và Google giả (không gửi mail thật), chạy trên database trong `DATABASE_URL`,
chỉ tạo và xoá dữ liệu có email dạng `authtest-...@example.com`.

## 6. Bảo mật đã có

| Biện pháp | Chi tiết |
|---|---|
| Mã OTP | 6 số sinh bằng `crypto.randomInt`, chỉ lưu hash HMAC-SHA256 trong DB |
| Hiệu lực | 5 phút, dùng 1 lần, mã mới vô hiệu mã cũ |
| Thử sai | tối đa 5 lần mỗi mã (đếm nguyên tử), sau đó mã bị khoá |
| Chống spam mail | gửi lại sau 60 giây, tối đa 5 mã mỗi email mỗi giờ, giới hạn theo IP |
| Không lộ thông tin | response không chứa mã; không cho biết email đã có tài khoản hay chưa |
| Cookie phiên | `httpOnly`, `sameSite=lax`; đặt `COOKIE_SECURE=1` khi chạy HTTPS |

## 7. Khi triển khai thật

- Đặt `NODE_ENV=production`, `COOKIE_SECURE=1`, `JWT_SECRET`, `OTP_SECRET` riêng.
- Nếu server nằm sau reverse proxy (Nginx, Cloudflare...) thêm `app.set('trust proxy', 1);` ngay sau
  `const app = express();` trong `server.js`, nếu không giới hạn theo IP sẽ thấy mọi người cùng một IP.
- Giới hạn tốc độ theo IP đang lưu trong bộ nhớ nên reset khi khởi động lại server và không chia sẻ giữa nhiều instance.
  Giới hạn theo email (lưu trong DB) thì có.
- Giống chức năng đăng ký có sẵn: **người đầu tiên** đăng nhập vào một database trống sẽ thành `admin`, bằng bất kỳ cách nào.
  Tự đăng nhập một lần trước khi mở hệ thống ra ngoài.

## 8. Xử lý sự cố

| Hiện tượng | Nguyên nhân thường gặp |
|---|---|
| Không thấy nút Google | `GOOGLE_CLIENT_ID` trống, chưa khởi động lại server, hoặc trình duyệt chặn `accounts.google.com` |
| Nút Google báo `origin_mismatch` | origin đang mở chưa được thêm vào *Authorized JavaScript origins* (kiểm tra `localhost` so với `127.0.0.1` và cổng) |
| Google báo `access_denied` / app chưa xác minh | app đang *Testing* và email chưa nằm trong *Test users* |
| Gửi mã báo "Không gửi được email" | xem log server dòng `[otp] gửi mail lỗi`. Lỗi `535` nghĩa là sai mật khẩu ứng dụng Gmail |
| Không thấy email | kiểm tra Spam; kiểm tra `MAIL_FROM` đúng địa chỉ của `SMTP_USER` |
| "Vui lòng đợi N giây" | chống gửi dồn, đợi hết đếm ngược rồi bấm Gửi lại mã |
