require("dotenv").config();

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

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

// ============================================================
// TELEGRAM API
// ============================================================

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

// ============================================================
// GITHUB API
// ============================================================

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

// ============================================================
// APPROVE PULL REQUEST
// ============================================================

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

// ============================================================
// APPROVE PUSH / DEPLOY
// ============================================================
//
// Push không có "GitHub PR approval".
// Ở đây Telegram approval sẽ gọi
// repository_dispatch để kích hoạt GitHub Actions.
//
// Workflow cần lắng nghe:
//
// on:
//   repository_dispatch:
//     types:
//       - telegram_push_approved
//
// ============================================================

async function approvePush(sha, branch, approvedBy) {
  console.log("Approving push...");

  console.log("SHA:", sha);

  console.log("Branch:", branch);

  console.log("Approved by Telegram User ID:", approvedBy);

  const response = await fetch(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/dispatches`,
    {
      method: "POST",

      headers: {
        Accept: "application/vnd.github+json",

        Authorization: `Bearer ${GITHUB_TOKEN}`,

        "X-GitHub-Api-Version": "2026-03-10",

        "Content-Type": "application/json",
      },

      body: JSON.stringify({
        event_type: "telegram_push_approved",

        client_payload: {
          sha: sha,

          branch: branch,

          approved_by: String(approvedBy),
        },
      }),
    }
  );

  if (!response.ok) {
    const error = await response.text();

    throw new Error(
      `GitHub API error: ${response.status} ${error}`
    );
  }

  console.log(
    "GitHub repository_dispatch sent successfully."
  );

  return true;
}

// ============================================================
// CHECK TELEGRAM PERMISSION
// ============================================================

async function checkPermission(query) {
  const userId = String(query.from.id);

  const chatId = String(
    query.message?.chat?.id || ""
  );

  // Nếu đã cấu hình User ID thì phải đúng User ID
  if (
    ALLOWED_TELEGRAM_USER_ID &&
    userId !== ALLOWED_TELEGRAM_USER_ID
  ) {
    return false;
  }

  // Nếu đã cấu hình Chat ID thì phải đúng Chat ID
  if (
    ALLOWED_TELEGRAM_CHAT_ID &&
    chatId !== ALLOWED_TELEGRAM_CHAT_ID
  ) {
    return false;
  }

  return true;
}

// ============================================================
// PROCESS TELEGRAM CALLBACK
// ============================================================

async function processCallback(query) {
  const callbackId = query.id;

  const data = query.data || "";

  console.log("");
  console.log("======================================");

  console.log("Telegram callback received:");

  console.log(data);

  console.log("======================================");

  // ----------------------------------------------------------
  // CHECK PERMISSION FIRST
  // ----------------------------------------------------------

  if (!(await checkPermission(query))) {
    await telegram("answerCallbackQuery", {
      callback_query_id: callbackId,

      text:
        "Bạn không có quyền thực hiện thao tác này.",

      show_alert: true,
    });

    console.log(
      "Unauthorized Telegram user:",
      query.from.id
    );

    return;
  }

  // ----------------------------------------------------------
  // SHOW PROCESSING MESSAGE
  // ----------------------------------------------------------

  await telegram("answerCallbackQuery", {
    callback_query_id: callbackId,

    text: "Đang xử lý...",
  });

  // ----------------------------------------------------------
  // PARSE CALLBACK DATA
  // ----------------------------------------------------------

  const parts = data.split(":");

  const type = parts[0];

  try {
    // ========================================================
    // PULL REQUEST
    // ========================================================
    //
    // Callback:
    //
    // approve_pr:123
    //
    // hoặc callback cũ:
    //
    // pr:123
    //
    // ========================================================

    if (
      type === "approve_pr" ||
      type === "pr"
    ) {
      const prNumber = Number(parts[1]);

      if (!Number.isInteger(prNumber)) {
        throw new Error(
          "PR number không hợp lệ."
        );
      }

      console.log(
        `Approving Pull Request #${prNumber}...`
      );

      await approvePullRequest(prNumber);

      console.log(
        `PR #${prNumber} approved successfully.`
      );

      // ------------------------------------------------------
      // UPDATE TELEGRAM MESSAGE
      // ------------------------------------------------------

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

    // ========================================================
    // PUSH / DEPLOY
    // ========================================================
    //
    // Callback:
    //
    // approve_push:<sha>:<branch>
    //
    // Ví dụ:
    //
    // approve_push:e3252671050c87ad4b837d7822581712a25e5704:quanhv/dev
    //
    // ========================================================

    if (
      type === "approve_push" ||
      type === "push"
    ) {
      const sha = parts[1];

      // Branch có thể chứa ":" nên không dùng parts[2]
      // đơn giản mà ghép phần còn lại.
      const branch = parts
        .slice(2)
        .join(":");

      if (!sha || !branch) {
        throw new Error(
          "Thông tin push không hợp lệ."
        );
      }

      console.log("Push approval information:");

      console.log("SHA:", sha);

      console.log("Branch:", branch);

      console.log(
        "Approved by:",
        query.from.id
      );

      // ------------------------------------------------------
      // TRIGGER GITHUB ACTIONS
      // ------------------------------------------------------

      await approvePush(
        sha,
        branch,
        query.from.id
      );

      console.log(
        `Push ${sha} approved successfully.`
      );

      console.log(
        "Deployment workflow triggered."
      );

      // ------------------------------------------------------
      // UPDATE TELEGRAM MESSAGE
      // ------------------------------------------------------

      if (query.message) {
        await telegram("editMessageText", {
          chat_id: query.message.chat.id,

          message_id: query.message.message_id,

          text:
            query.message.text +
            "\n\n" +
            "✅ DEPLOY APPROVED VIA TELEGRAM" +
            "\n" +
            "🚀 Deployment workflow started.",

          reply_markup: {
            inline_keyboard: [],
          },
        });
      }

      return;
    }

    // ========================================================
    // UNKNOWN CALLBACK
    // ========================================================

    console.log(
      "Unknown callback:",
      data
    );

  } catch (error) {
    // --------------------------------------------------------
    // ERROR
    // --------------------------------------------------------

    console.error(
      "Callback processing error:"
    );

    console.error(error);

    if (query.message) {
      await telegram("sendMessage", {
        chat_id: query.message.chat.id,

        text:
          "❌ Không thể thực hiện thao tác.\n\n" +
          error.message,
      });
    }
  }
}

// ============================================================
// PROCESS TELEGRAM MESSAGE
// ============================================================

async function processMessage(message) {
  const text = message.text || "";

  // ==========================================================
  // /id
  // ==========================================================

  if (text === "/id") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,

      text:
        `Telegram User ID: ${message.from.id}\n` +
        `Chat ID: ${message.chat.id}`,
    });

    return;
  }

  // ==========================================================
  // /start
  // ==========================================================

  if (text === "/start") {
    await telegram("sendMessage", {
      chat_id: message.chat.id,

      text:
        "🤖 GitHub Notification Bot\n\n" +
        "Dùng /id để xem Telegram User ID và Chat ID.",
    });

    return;
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  // ==========================================================
  // CHECK ENV
  // ==========================================================

  if (!TELEGRAM_BOT_TOKEN) {
    throw new Error(
      "Missing TELEGRAM_BOT_TOKEN"
    );
  }

  if (!GITHUB_TOKEN) {
    throw new Error(
      "Missing GITHUB_TOKEN"
    );
  }

  if (!GITHUB_OWNER) {
    throw new Error(
      "Missing GITHUB_OWNER"
    );
  }

  if (!GITHUB_REPO) {
    throw new Error(
      "Missing GITHUB_REPO"
    );
  }

  console.log(
    "Starting Telegram bot..."
  );

  // ==========================================================
  // DELETE WEBHOOK
  // ==========================================================
  //
  // Bot sử dụng long polling nên không dùng webhook.
  //
  // ==========================================================

  await telegram("deleteWebhook", {
    drop_pending_updates: false,
  });

  console.log(
    "Telegram bot is running."
  );

  console.log(
    `GitHub repository: ${GITHUB_OWNER}/${GITHUB_REPO}`
  );

  // ==========================================================
  // LONG POLLING
  // ==========================================================

  while (true) {
    try {
      const updates = await telegram(
        "getUpdates",
        {
          offset: offset,

          timeout: 50,

          allowed_updates: [
            "message",
            "callback_query",
          ],
        }
      );

      // ======================================================
      // PROCESS UPDATES
      // ======================================================

      for (const update of updates) {
        // ----------------------------------------------------
        // Update offset
        // ----------------------------------------------------

        offset =
          update.update_id + 1;

        try {
          // --------------------------------------------------
          // CALLBACK QUERY
          // --------------------------------------------------

          if (update.callback_query) {
            await processCallback(
              update.callback_query
            );
          }

          // --------------------------------------------------
          // NORMAL MESSAGE
          // --------------------------------------------------

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
      // ======================================================
      // POLLING ERROR
      // ======================================================

      console.error(
        "Polling error:",
        error.message
      );

      await new Promise(
        resolve =>
          setTimeout(resolve, 5000)
      );
    }
  }
}

// ============================================================
// START BOT
// ============================================================

main().catch(error => {
  console.error(error);

  process.exit(1);
});