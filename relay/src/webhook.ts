import express, { type Express } from "express";
import { createCorrelationId } from "./correlation.js";

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramPhoto {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhoto[];
  from?: TelegramUser;
}

type LogLevel = "INFO" | "WARN" | "ERROR";

type WebhookDependencies = {
  webhookSecret: string;
  allowedUserIds: ReadonlySet<number>;
  maxImageSize: number;
  handleAuthorizedMessage: (
    message: TelegramMessage,
    correlationId: string
  ) => Promise<void>;
  notifyUnauthorized: (chatId: number) => Promise<void>;
  notifyOversizedImage: (chatId: number) => Promise<void>;
  log: (level: LogLevel, event: string, data?: Record<string, unknown>) => void;
};

function isMessage(value: unknown): value is TelegramMessage {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<TelegramMessage>;
  return (
    typeof candidate.message_id === "number" &&
    Boolean(candidate.chat) &&
    typeof candidate.chat?.id === "number" &&
    typeof candidate.chat?.type === "string"
  );
}

export function createTelegramWebhookApp(deps: WebhookDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(express.json({ limit: "2mb" }));

  app.get("/health", (_req, res) => {
    res.status(200).json({
      status: "ok",
      service: "fieldops-telegram-relay",
      telegram: "webhook",
      copilot: "direct-line",
      vision: "enabled"
    });
  });

  app.post("/telegram/webhook", (req, res) => {
    if (req.get("X-Telegram-Bot-Api-Secret-Token") !== deps.webhookSecret) {
      deps.log("WARN", "telegram.webhook.secret_rejected");
      res.sendStatus(401);
      return;
    }

    const update = req.body as { update_id?: unknown; message?: unknown };
    if (!update || typeof update.update_id !== "number" || (update.message !== undefined && !isMessage(update.message))) {
      deps.log("WARN", "telegram.webhook.invalid_update");
      res.sendStatus(400);
      return;
    }

    res.sendStatus(200);
    deps.log("INFO", "telegram.webhook.update_received", {
      update_id: update.update_id,
      has_message: Boolean(update.message)
    });

    if (!update.message) return;

    const message = update.message;
    const correlationId = createCorrelationId();
    const userId = message.from?.id;

    let operation: Promise<void>;
    if (userId === undefined || !deps.allowedUserIds.has(userId)) {
      deps.log("WARN", "telegram.auth.denied", {
        correlation_id: correlationId,
        telegram_user_id: userId,
        chat_id: message.chat.id
      });
      operation = deps.notifyUnauthorized(message.chat.id);
    } else {
      const largestPhoto = message.photo?.at(-1);
      if (largestPhoto?.file_size !== undefined && largestPhoto.file_size > deps.maxImageSize) {
        deps.log("WARN", "telegram.photo.oversized", {
          correlation_id: correlationId,
          chat_id: message.chat.id,
          photo_size: largestPhoto.file_size
        });
        operation = deps.notifyOversizedImage(message.chat.id);
      } else {
        operation = deps.handleAuthorizedMessage(message, correlationId);
      }
    }

    void operation.catch((error) => {
      deps.log("ERROR", "telegram.webhook.processing_failed", {
        update_id: update.update_id,
        correlation_id: correlationId,
        error: error instanceof Error ? error.message : String(error)
      });
    });
  });

  return app;
}
