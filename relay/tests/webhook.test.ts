import test from "node:test";
import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import { loadRelayConfig } from "../src/config.js";
import { createTelegramWebhookApp, type TelegramMessage } from "../src/webhook.js";

type LogEntry = { level: string; event: string; data?: Record<string, unknown> };

function message(overrides: Partial<TelegramMessage> = {}): TelegramMessage {
  return {
    message_id: 10,
    chat: { id: 20, type: "private" },
    from: { id: 30, is_bot: false, first_name: "Tech" },
    text: "Estado de OT-1042",
    ...overrides
  };
}

async function withApp(
  options: {
    handle?: (message: TelegramMessage, correlationId: string) => Promise<void>;
    unauthorized?: (chatId: number) => Promise<void>;
    oversized?: (chatId: number) => Promise<void>;
    logs?: LogEntry[];
  },
  action: (baseUrl: string) => Promise<void>
) {
  const logs = options.logs ?? [];
  const app = createTelegramWebhookApp({
    webhookSecret: "webhook-secret",
    allowedUserIds: new Set([30]),
    maxImageSize: 100,
    handleAuthorizedMessage: options.handle ?? (async () => undefined),
    notifyUnauthorized: options.unauthorized ?? (async () => undefined),
    notifyOversizedImage: options.oversized ?? (async () => undefined),
    log: (level, event, data) => logs.push({ level, event, data })
  });
  const server: Server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await action(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}

function post(baseUrl: string, body: unknown, secret = "webhook-secret") {
  return fetch(`${baseUrl}/telegram/webhook`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": secret
    },
    body: JSON.stringify(body)
  });
}

test("rejects a malformed Telegram webhook", async () => {
  await withApp({}, async (baseUrl) => {
    const response = await post(baseUrl, { update_id: 1, message: { message_id: 2 } });
    assert.equal(response.status, 400);
  });
});

test("rejects an invalid webhook secret", async () => {
  await withApp({}, async (baseUrl) => {
    const response = await post(baseUrl, { update_id: 1 }, "wrong-secret");
    assert.equal(response.status, 401);
  });
});

test("rejects an unauthorized Telegram user before agent processing", async () => {
  let handled = false;
  let deniedChat: number | undefined;
  await withApp({
    handle: async () => { handled = true; },
    unauthorized: async (chatId) => { deniedChat = chatId; }
  }, async (baseUrl) => {
    const response = await post(baseUrl, { update_id: 1, message: message({ from: { id: 99, is_bot: false, first_name: "No" } }) });
    assert.equal(response.status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handled, false);
    assert.equal(deniedChat, 20);
  });
});

test("dispatches authorized text", async () => {
  let receivedText: string | undefined;
  await withApp({
    handle: async (received) => { receivedText = received.text; }
  }, async (baseUrl) => {
    assert.equal((await post(baseUrl, { update_id: 1, message: message() })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(receivedText, "Estado de OT-1042");
  });
});

test("rejects an oversized image before agent processing", async () => {
  let handled = false;
  let notified = false;
  await withApp({
    handle: async () => { handled = true; },
    oversized: async () => { notified = true; }
  }, async (baseUrl) => {
    const photo = { file_id: "f", file_unique_id: "u", width: 10, height: 10, file_size: 101 };
    assert.equal((await post(baseUrl, { update_id: 1, message: message({ text: undefined, photo: [photo] }) })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(handled, false);
    assert.equal(notified, true);
  });
});

test("fails closed when required environment variables are missing", () => {
  assert.throws(() => loadRelayConfig({}), /Falta TELEGRAM_/);
});

test("generates a UUID correlation ID for authorized processing", async () => {
  let correlationId = "";
  await withApp({
    handle: async (_message, receivedCorrelationId) => { correlationId = receivedCorrelationId; }
  }, async (baseUrl) => {
    await post(baseUrl, { update_id: 1, message: message() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(correlationId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });
});

test("contains asynchronous processing errors and logs a safe event", async () => {
  const logs: LogEntry[] = [];
  await withApp({
    logs,
    handle: async () => { throw new Error("simulated upstream failure"); }
  }, async (baseUrl) => {
    assert.equal((await post(baseUrl, { update_id: 1, message: message() })).status, 200);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const failure = logs.find((entry) => entry.event === "telegram.webhook.processing_failed");
    assert.equal(failure?.level, "ERROR");
    assert.equal(failure?.data?.error, "simulated upstream failure");
  });
});
