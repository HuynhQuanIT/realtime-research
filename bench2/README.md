# bench2 - harness đo có thể tái lập (P0)

Chạy trên Linux. Cần Postgres (docker compose up -d ở thư mục gốc, cổng 5433) và `npm install`.

    export DATABASE_URL=postgres://postgres:postgres@localhost:5433/notifybench
    # (tuỳ chọn) ghim CPU:  export TASKSET_SERVER=0-3  TASKSET_LOAD=4-11
    node bench2/run.js --mechs poll,sse,ws,push --levels 10,100,500,1000 \
         --reps 10 --duration 120 --warmup 10 --rate 10 --poll 2000 --seed 1
    node bench2/analyze.js <RUN_ID>      # -> results/<RUN_ID>/summary.md, summary.csv, ecdf.csv

Thử nhanh: --levels 10,100 --reps 2 --duration 6 --warmup 2 --rate 5 --poll 1000

Tham số khác: --burst B (B message mỗi tick), --payload BYTES (<7000), --perproc 250, --port 3100.

Mỗi run: server MỚI -> TRUNCATE -> workers kết nối -> warm-up -> đo -> drain -> lưu log -> kill server.
Thứ tự run được shuffle theo --seed (plan.json lưu lại để tái lập).

Log từng sự kiện: events-*.bin (float64 x5: client, msgId, tc, tb, tr), gen.ndjson, stats.ndjson, meta.json.
Kênh "push" là EMULATED (log-normal, PUSH_MEDIAN_MS / PUSH_SIGMA), không phải FCM.
