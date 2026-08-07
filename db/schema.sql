-- Bảng lưu message
CREATE TABLE IF NOT EXISTS messages (
  id BIGSERIAL PRIMARY KEY,
  content TEXT NOT NULL,
  sender TEXT NOT NULL DEFAULT 'anonymous',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Cho DB đã tạo từ trước (chưa có cột sender) — chạy an toàn, không lỗi nếu đã có cột.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS sender TEXT NOT NULL DEFAULT 'anonymous';

-- Function bắn NOTIFY mỗi khi có insert mới
CREATE OR REPLACE FUNCTION notify_new_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify(
    'new_message',
    json_build_object(
      'id', NEW.id,
      'content', NEW.content,
      'sender', NEW.sender,
      'created_at', NEW.created_at
    )::text
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger gắn vào bảng messages
DROP TRIGGER IF EXISTS trg_notify_new_message ON messages;
CREATE TRIGGER trg_notify_new_message
AFTER INSERT ON messages
FOR EACH ROW EXECUTE FUNCTION notify_new_message();