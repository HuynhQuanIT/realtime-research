# Notify Benchmark — Polling vs SSE vs WebSocket vs FCM (trên nền Postgres LISTEN/NOTIFY)

Kiểm chứng thực tế cho phần phân tích: 4 cách đẩy dữ liệu real-time đều
dùng **chung một nguồn phát** (Postgres trigger `NOTIFY`), để so latency
và chi phí tài nguyên một cách công bằng.

```
Postgres (INSERT → trigger → pg_notify)
        │
        ▼
   Node.js backend (LISTEN, EventEmitter dùng chung)
        │
   ┌────┼─────────┬───────────┐
 Polling  SSE   WebSocket   FCM (mock)
        │
     Clients
```

## 1. Cài đặt

```bash
cd notify-benchmark
npm install          # cài express, pg, ws
docker compose up -d # chạy Postgres local, tự load db/schema.sql
```

Không dùng Docker? Tạo DB `notifybench` trong Postgres có sẵn rồi chạy:

```bash
psql -U postgres -d notifybench -f db/schema.sql
```

Sửa biến `DATABASE_URL` trong `.env` hoặc export trực tiếp nếu connection
string khác mặc định (`postgres://postgres:postgres@localhost:5432/notifybench`).

## 2. Chạy server

```bash
npm start
# Server chạy tại http://localhost:3000
```

Endpoint có sẵn:

| Method | Path            | Mô tả                                   |
|--------|-----------------|-------------------------------------------|
| POST   | `/messages`     | Insert message (nguồn phát cho mọi kênh)  |
| GET    | `/poll?since=`  | Polling                                   |
| GET    | `/sse`          | Server-Sent Events                        |
| WS     | `/ws`           | WebSocket                                 |
| POST   | `/fcm/register` | Đăng ký token (mô phỏng)                  |
| GET    | `/fcm/stream`   | Push thật (SSE) cho kênh FCM — dùng để đo latency |
| GET    | `/fcm/sent`     | Xem log 100 message FCM gần nhất (chỉ để debug, không dùng đo latency) |
| GET    | `/metrics`      | RAM/CPU/số client WS hiện tại             |
| GET    | `/results`      | CSV benchmark mới nhất, phục vụ dashboard `public/index.html` |

Mở `http://localhost:3000` sau khi chạy server để xem dashboard trực quan:
live demo 4 kênh (có tab chọn xem riêng từng kênh) + biểu đồ/bảng số liệu
đọc từ CSV mới nhất trong `loadtest/results/`.

Test nhanh bằng tay:

```bash
curl -X POST localhost:3000/messages -H 'Content-Type: application/json' \
  -d '{"content":"hello"}'
```

## 3. Chạy load test

Test 1 phương pháp, N client, trong T giây:

```bash
node loadtest/run.js ws   1000 30      # 1000 client WebSocket, 30 giây
node loadtest/run.js sse  1000 30
node loadtest/run.js poll 1000 30 2000 # poll mỗi 2000ms
```

Kết quả in ra console + lưu JSON tại `loadtest/results/<method>-<clients>.summary.json`,
gồm: số client kết nối/lỗi, số message nhận được, latency avg/p50/p95/p99/max,
RAM trung bình/đỉnh, CPU user tăng trung bình mỗi giây.

Chạy toàn bộ ma trận (3 phương pháp × các mức tải 100/500/1000/5000/10000,
đúng theo bảng kịch bản test bạn đã lập) và gom vào 1 CSV:

```bash
bash loadtest/bench-all.sh
```

> Sửa mảng `CLIENT_LEVELS` và `DURATION` trong `bench-all.sh` nếu muốn đổi
> mức tải hoặc thời lượng mỗi lượt.

## 4. Về phần FCM

FCM thật cần `firebase-admin` + service account + token thiết bị thật nên
không thể benchmark bằng máy chủ giả lập. File `server.js` mô phỏng đúng
"hình dạng" chi phí (round-trip 50–150ms ra provider bên ngoài) để đưa vào
cùng khung so sánh.

Kênh FCM được đẩy (push) thật qua `GET /fcm/stream` (SSE riêng, tách khỏi
kênh `/sse` chính) — client **không** polling `/fcm/sent` để lấy dữ liệu.
Nếu để client tự poll, latency đo được sẽ bị cộng thêm chu kỳ polling và
không còn phản ánh đúng chi phí push giả lập nữa. Endpoint `/fcm/sent` vẫn
giữ lại để xem log 100 tin nhắn gần nhất, không dùng để đo latency.

Khi có credentials thật, thay đoạn `setTimeout` trong `server.js` bằng:

```js
const admin = require('firebase-admin');
await admin.messaging().sendEachForMulticast({ tokens, notification: {...} });
```

## 5. Đọc kết quả thế nào

- **Latency avg/p95**: SSE và WebSocket phải thấp hơp hẳn Polling (vì Polling
  bị giới hạn bởi interval — trung bình chờ ~interval/2).
- **RAM/CPU tăng theo số client**: WebSocket thường tốn RAM nhất khi client
  cao (mỗi kết nối giữ 1 socket mở), Polling tốn CPU nhất khi client cao
  (mỗi request là 1 round-trip HTTP đầy đủ).
- Dùng CSV từ `bench-all.sh` để vẽ biểu đồ latency/RAM theo số client cho
  từng phương pháp, đó chính là dữ liệu để chốt kiến trúc cuối cùng.


# Telegram notification test
