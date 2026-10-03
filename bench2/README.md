# bench2 - bộ đo có thể tái lập cho bài báo

Đo và so sánh các cơ chế phân phối dữ liệu thời gian thực (Polling, SSE, WebSocket, push mô phỏng,
WebSocket gom tin) và workload stream token của LLM. Thay cho `loadtest/` cũ (bản đã tạo số liệu của bài bị từ chối).

## Chạy một lệnh

    node bench2/final.js --pilot --fresh     # chạy thử rút gọn (~30-40 phút): kiểm tra mọi thứ trước khi chạy thật
    node bench2/final.js                     # chạy thật, đầy đủ (~13 giờ)
    node bench2/final.js --preset quick      # chạy thật, ít lần lặp hơn (~7 giờ)
    node bench2/final.js --stages main,ab    # chỉ một số giai đoạn (chia nhiều đêm)
    node bench2/final.js --dry               # in kế hoạch và ước tính, không chạy
    node bench2/final.js --analyze-only      # phân tích lại từ dữ liệu đã có

Ngắt giữa chừng thì chạy lại ĐÚNG lệnh cũ để chạy tiếp (run đã có `meta.json` được bỏ qua).
Báo cáo tổng hợp: `bench2/results/<tiền tố>-REPORT.md` (tiền tố: `pilot-`, `final-`, `finalq-`).

## Các giai đoạn

| giai đoạn | trả lời câu hỏi gì |
|---|---|
| main | poll / SSE / WS / push mô phỏng / WS gom tin theo số client 10-1000 |
| sweep | điểm giao CPU giữa poll và push theo tốc độ tin, ngưỡng bão hoà, gom tin có dịch chuyển chúng không |
| ab | poll bản sửa so với poll cũ nguyên bản (và bản trung gian "bầy đàn"): lỗi nào gây ra hiện tượng gì |
| llm | stream token LLM: TTFT, nhịp token (khựng, dồn cụm), độ trễ huỷ, token lãng phí, tài nguyên |

## Cơ chế

- `poll`: bản đã sửa (cursor theo seq, pha ngẫu nhiên, không chồng request, tra buffer O(1))
- `poll-herd`: hành vi client cũ (setInterval, mọi client khởi động cùng lúc, request chồng nhau) + server đã sửa
- `poll-legacy`: tái hiện nguyên bản poll cũ (cursor theo giờ server, quét cả buffer 5000 phần tử)
- `sse`, `ws`: như cũ. `push`: MÔ PHỎNG (log-normal), không phải FCM
- `wsb<ms>`: WebSocket gom tin, ví dụ `wsb25` gom các tin trong cửa sổ 25 ms rồi gửi 1 gói/client
- `llm-sse` (huỷ = đóng kết nối), `llm-ws` (huỷ = message trong cùng kết nối), `llm-poll` (huỷ = POST)

## Chạy từng phần bằng tay

    node bench2/run.js --mechs poll,ws --levels 10,100 --reps 5 --duration 60 --warmup 10 --rate 10 --poll 2000
    node bench2/run.js --workload llm --mechs llm-sse,llm-ws,llm-poll --levels 50,100 --reps 5 --tokens 200 --tokrate 20 --cancelp 0.3 --poll 250
    node bench2/analyze.js <RUN_ID>          # broadcast
    node bench2/llm-analyze.js <RUN_ID>      # llm
    node bench2/sweep.js <N> [RUN_ID ...]    # gom các lần quét tốc độ tin

Tham số khác: `--burst`, `--payload`, `--perproc`, `--port`, `--retries`, `--cooldown`, `--runid`, `--resume 1`.

## Thiết kế để kết quả đáng tin

Mỗi run: server MỚI -> reset -> client kết nối -> warm-up -> đo -> drain -> lưu log -> tắt server. Thứ tự run được shuffle
theo seed. Mọi thời điểm dùng `process.hrtime` (cùng gốc giữa các tiến trình trên cùng máy). Log từng sự kiện ở dạng nhị phân.
Run lỗi hạ tầng (tiến trình sập, treo) tự chạy lại và được ghi vào `errors.log`; run thiếu hoặc không hợp lệ được cảnh báo,
không bị trộn lặng lẽ vào thống kê.

## Giới hạn cần ghi trong bài

- Loadgen và server chạy CÙNG máy (cùng hrtime nên số đo thời gian nhất quán, nhưng chia sẻ CPU).
- Server Node đơn luồng với thư viện `ws`; điểm giao và ngưỡng bão hoà phụ thuộc cài đặt.
- Kênh push là mô phỏng; workload LLM dùng mock (không phải mô hình thật): kết quả đặc trưng cho tầng truyền tải.
- Không tắt được hoàn toàn nhiễu của hệ điều hành; chạy khi máy rảnh, cắm sạc, không bấm vào cửa sổ terminal.
