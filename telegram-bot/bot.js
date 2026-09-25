require("dotenv").config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = String(process.env.TELEGRAM_CHAT_ID);

const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const GITHUB_OWNER = process.env.GITHUB_OWNER;
const GITHUB_REPO = process.env.GITHUB_REPO;

const ALLOWED_TELEGRAM_USER_ID =
  process.env.ALLOWED_TELEGRAM_USER_ID
    ? String(process.env.ALLOWED_TELEGRAM_USER_ID)
    : "";

const ALLOWED_TELEGRAM_CHAT_ID =
  process.env.ALLOWED_TELEGRAM_CHAT_ID
    ? String(process.env.ALLOWED_TELEGRAM_CHAT_ID)
    : "";

let offset = 0;

async function telegram(method, body = {}) {
  const response = await fetch(
    `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    }
  );

  const data = await response.json();

  if (!data.ok) {
    throw new Error(
      `Telegram API error: ${JSON.stringify(data)}`
    );
  }

  return data.result;
}

async function github(path, options = {}) {
  const response = await fetch(
    `https://api.github.com${path}`,
    {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2026-03-10",
        "Content-Type": "application/json",
        ...(options.headers || {}),
      },
    }
  );

  const text = await response.text();

  let data;

  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(
      `GitHub API ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function approvePullRequest(prNumber) {
  console.log(`Approving PR #${prNumber}`);

  return await github(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/pulls/${prNumber}/reviews`,
    {
      method: "POST",
      body: JSON.stringify({
        event: "APPROVE",
        body: "Approved via Telegram",
      }),
    }
  );
}

async function approvePush(sha, branch, telegramUserId) {
  console.log(`Approving push ${sha}`);

  return await github(
    `/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
    {
      method: "POST",
      body: JSON.stringify({
        event_type: "telegram_push_approved",

        client_payload: {
          sha: sha,
          branch: branch,
          approved_by: String(telegramUserId),
        },
      }),
    }
  );
}

async function checkPermission(query) {
  const userId = String(query.from.id);
  const chatId = String(query.message?.chat?.id);

  if (
    ALLOWED_TELEGRAM_USER_ID &&
    userId !== ALLOWED_TELEGRAM_USER_ID
  ) {
    return false;
  }

  if (
    ALLOWED_TELEGRAM_CHAT_ID &&
    chatId !== ALLOWED_TELEGRAM_CHAT_ID
  ) {
    return false;
  }

  return true;
}

async function processCallback(query) {
  const callbackId = query.id;
  const data = query.data || "";

  await telegram("answerCallbackQuery", {
    callback_query_id: callbackId,
    text: "Đang xử lý...",
  });

  if (!(await checkPermission(query))) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,
      text: "Bạn không có quyền thực hiện thao tác này.",
      show_alert: true,
    });

    return;
  }

  const parts = data.split(":");
  const type = parts[0];

  try {
    // =========================
    // PULL REQUEST
    // =========================

    if (type === "pr") {
      const prNumber = Number(parts[1]);

      if (!Number.isInteger(prNumber)) {
        throw new Error("PR number không hợp lệ.");
      }

      await approvePullRequest(prNumber);

      console.log(`PR #${prNumber} approved.`);

      if (query.message) {
        await telegram("editMessageText", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,

          text:
            query.message.text +
            "\n\n✅ APPROVED VIA TELEGRAM",

          reply_markup: {
            inline_keyboard: [],
          },
        });
      }

      return;
    }

    // =========================
    // PUSH
    // =========================

    if (type === "push") {
      const sha = parts[1];
      const branch = parts.slice(2).join(":");

      if (!sha || !branch) {
        throw new Error("Thông tin push không hợp lệ.");
      }

      await approvePush(
        sha,
        branch,
        query.from.id
      );

      console.log(
        `Push ${sha} approved. Deployment workflow triggered.`
      );

      if (query.message) {
        await telegram("editMessageText", {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,

          text:
            query.message.text +
            "\n\n✅ DEPLOY APPROVED VIA TELEGRAM\n🚀 Deployment workflow started.",

          reply_markup: {
            inline_keyboard: [],
          },
        });
      }

      return;
    }

    console.log("Unknown callback:", data);

  } catch (error) {
    console.error(error);

    if (query.message) {
      await telegram("sendMessage", {
        chat_id: query.message.chat.id,

        text:
          `❌ Không thể thực hiện thao tác.\n\n` +
          `${error.message}`,
      });
    }
  }
}

async function processMessage(message) {
  const text = message.text || "";

  if (text === "/id") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,

      text:
        `Telegram User ID: ${message.from.id}\n` +
        `Chat ID: ${message.chat.id}`,
    });
  }

  if (text === "/start") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,

      text:
        "🤖 GitHub Notification Bot\n\n" +
        "Dùng /id để xem Telegram User ID và Chat ID.",
    });
  }
}

async function main() {
  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error("Missing TELEGRAM_BOT_TOKEN");
  }

  if (!GITHUB_TOKEN) {
    throw new Error("Missing GITHUB_TOKEN");
  }

  console.log("Starting Telegram bot...");

  // Đảm bảo không còn webhook cũ
  await telegram("deleteWebhook", {
    drop_pending_updates: false,
  });

  console.log("Telegram bot is running.");

  while (true) {
    try {
      const updates = await telegram("getUpdates", {
        offset: offset,
        timeout: 50,

        allowed_updates: [
          "message",
          "callback_query",
        ],
      });

      for (const update of updates) {
        offset = update.update_id + 1;

        try {
          if (update.callback_query) {
            await processCallback(
              update.callback_query
            );
          }

          if (update.message) {
            await processMessage(
              update.message
            );
          }
        } catch (error) {
          console.error(
            "Error processing update:",
            error
          );
        }
      }

    } catch (error) {
      console.error(
        "Polling error:",
        error.message
      );

      await new Promise(
        resolve => setTimeout(resolve, 5000)
      );
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});