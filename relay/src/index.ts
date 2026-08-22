import "dotenv/config";

import {
  randomUUID
} from "node:crypto";

import {
  mkdir,
  readFile,
  stat,
  writeFile
} from "node:fs/promises";

import path from "node:path";

import express, {
  Request,
  Response
} from "express";

/* =========================================================
   CONFIGURACIÓN
========================================================= */

function requireEnv(
  name: string
): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(
      `Falta ${name}. Revisa el archivo .env.`
    );
  }

  return value;
}

const telegramToken =
  requireEnv(
    "TELEGRAM_BOT_TOKEN"
  );

const copilotTokenEndpoint =
  requireEnv(
    "COPILOT_TOKEN_ENDPOINT"
  );

const telegramWebhookSecret =
  requireEnv(
    "TELEGRAM_WEBHOOK_SECRET"
  );

const telegramAllowedUserIds =
  new Set(
    requireEnv(
      "TELEGRAM_ALLOWED_USER_IDS"
    )
      .split(",")
      .map(
        (value) =>
          Number(
            value.trim()
          )
      )
      .filter(
        (value) =>
          Number.isSafeInteger(
            value
          )
      )
  );

const PORT =
  Number(
    process.env.PORT ?? 3000
  );

const TELEGRAM_API =
  `https://api.telegram.org/bot${telegramToken}`;

const TELEGRAM_FILE_API =
  `https://api.telegram.org/file/bot${telegramToken}`;

const DIRECT_LINE =
  "https://directline.botframework.com/v3/directline";

const TEMP_DIR =
  path.resolve(
    "tmp",
    "telegram"
  );

const COPILOT_TIMEOUT_MS =
  90_000;

const TOKEN_REFRESH_MARGIN_MS =
  5 * 60 * 1000;

const TELEGRAM_MAX_MESSAGE_LENGTH =
  3900;

const MAX_IMAGE_SIZE =
  15 * 1024 * 1024;

/* =========================================================
   TIPOS TELEGRAM
========================================================= */

interface TelegramResponse<T> {
  ok: boolean;
  result: T;
  description?: string;
}

interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
}

interface TelegramChat {
  id: number;
  type: string;
}

interface TelegramPhoto {
  file_id: string;
  file_unique_id: string;
  width: number;
  height: number;
  file_size?: number;
}

interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;

  text?: string;
  caption?: string;

  photo?: TelegramPhoto[];

  from?: TelegramUser;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface TelegramFile {
  file_id: string;
  file_unique_id: string;
  file_size?: number;
  file_path?: string;
}

/* =========================================================
   FIELDOPS
========================================================= */

interface FieldOpsInboundMessage {
  source: "telegram";
  type: "text" | "photo";

  chat_id: number;
  message_id: number;

  technician: {
    telegram_user_id?: number;
    username?: string;
    first_name?: string;
  };

  text?: string;

  attachment?: {
    telegram_file_id: string;
    telegram_file_unique_id: string;
    width: number;
    height: number;
    file_size?: number;
    local_path: string;
  };

  received_at: string;
}

/* =========================================================
   DIRECT LINE / COPILOT
========================================================= */

interface CopilotTokenResponse {
  token: string;
  expires_in: number;
  conversationId: string;
}

interface DirectLineConversationResponse {
  conversationId: string;
  token?: string;
  expires_in?: number;
  streamUrl?: string;
}

interface DirectLineSendResponse {
  id: string;
}

interface DirectLineActivity {
  id?: string;
  type: string;

  from?: {
    id?: string;
    name?: string;
    role?: string;
  };

  text?: string;
}

interface DirectLineActivitySet {
  activities: DirectLineActivity[];
  watermark?: string;
}

interface CopilotSession {
  token: string;
  conversationId: string;
  expiresAt: number;
  watermark?: string;
}

/* =========================================================
   SESIONES

   Una conversación Direct Line por chat_id de Telegram.
========================================================= */

const copilotSessions =
  new Map<number, CopilotSession>();

/* =========================================================
   UTILIDADES
========================================================= */

type LogLevel =
  "INFO" |
  "WARN" |
  "ERROR";

function logEvent(
  level: LogLevel,
  event: string,
  data: Record<string, unknown> = {}
): void {
  console.log(
    JSON.stringify({
      timestamp:
        new Date().toISOString(),

      level,

      service:
        "fieldops-telegram-relay",

      event,

      ...data
    })
  );
}

function createCorrelationId():
string {
  return randomUUID();
}

function sleep(
  ms: number
): Promise<void> {
  return new Promise(
    (resolve) => {
      setTimeout(
        resolve,
        ms
      );
    }
  );
}

function technicianFrom(
  message: TelegramMessage
): FieldOpsInboundMessage["technician"] {
  return {
    telegram_user_id:
      message.from?.id,

    username:
      message.from?.username,

    first_name:
      message.from?.first_name
  };
}

function technicianName(
  message: TelegramMessage
): string {
  return (
    message.from?.first_name ??
    message.from?.username ??
    "Técnico FieldOps"
  );
}

function telegramUserId(
  message: TelegramMessage
): number {
  return (
    message.from?.id ??
    message.chat.id
  );
}

function directLineUserId(
  message: TelegramMessage
): string {
  return (
    `telegram:${telegramUserId(message)}`
  );
}

function isTelegramUserAllowed(
  message: TelegramMessage
): boolean {
  const userId =
    message.from?.id;

  if (
    userId === undefined
  ) {
    return false;
  }

  return telegramAllowedUserIds.has(
    userId
  );
}

/* =========================================================
   MIME DE IMÁGENES
========================================================= */

function getImageMimeType(
  filePath: string
): string {
  const extension =
    path
      .extname(filePath)
      .toLowerCase();

  switch (extension) {
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";

    case ".png":
      return "image/png";

    case ".webp":
      return "image/webp";

    case ".gif":
      return "image/gif";

    default:
      throw new Error(
        `Formato de imagen no soportado: ${extension}`
      );
  }
}

/* =========================================================
   TELEGRAM API
========================================================= */

async function telegramRequest<T>(
  method: string,
  body?: Record<string, unknown>
): Promise<T> {
  const response =
    await fetch(
      `${TELEGRAM_API}/${method}`,
      body
        ? {
            method:
              "POST",

            headers: {
              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify(body)
          }
        : undefined
    );

  const data =
    (await response.json()) as TelegramResponse<T>;

  if (
    !response.ok ||
    !data.ok
  ) {
    throw new Error(
      `Telegram API error en ${method}: ${
        data.description ??
        response.statusText
      }`
    );
  }

  return data.result;
}

/* =========================================================
   LIMPIAR RESPUESTA DE COPILOT
========================================================= */

function cleanCopilotText(
  text: string
): string {
  let cleaned =
    text
      .replace(
        /\*\*(.*?)\*\*/g,
        "$1"
      )
      .replace(
        /__(.*?)__/g,
        "$1"
      )
      .replace(
        /`([^`]+)`/g,
        "$1"
      )
      .replace(
        /^#{1,6}\s+/gm,
        ""
      );

  cleaned =
    cleaned.replace(
      /\[([^\]]+)\]\([^)]+\)/g,
      "$1"
    );

  cleaned =
    cleaned.replace(
      /^\[\d+\]:\s*.*$/gm,
      ""
    );

  cleaned =
    cleaned.replace(
      /(?:\[\d+\])+/g,
      ""
    );

  cleaned =
    cleaned.replace(
      /[ \t]+\n/g,
      "\n"
    );

  cleaned =
    cleaned.replace(
      /\n{3,}/g,
      "\n\n"
    );

  return cleaned.trim();
}

/* =========================================================
   DIVIDIR MENSAJES TELEGRAM
========================================================= */

function splitTelegramMessage(
  text: string
): string[] {
  if (
    text.length <=
    TELEGRAM_MAX_MESSAGE_LENGTH
  ) {
    return [text];
  }

  const parts: string[] =
    [];

  let remaining =
    text;

  while (
    remaining.length >
    TELEGRAM_MAX_MESSAGE_LENGTH
  ) {
    let splitAt =
      remaining.lastIndexOf(
        "\n",
        TELEGRAM_MAX_MESSAGE_LENGTH
      );

    if (
      splitAt <
      TELEGRAM_MAX_MESSAGE_LENGTH / 2
    ) {
      splitAt =
        remaining.lastIndexOf(
          " ",
          TELEGRAM_MAX_MESSAGE_LENGTH
        );
    }

    if (
      splitAt <= 0
    ) {
      splitAt =
        TELEGRAM_MAX_MESSAGE_LENGTH;
    }

    const part =
      remaining
        .slice(
          0,
          splitAt
        )
        .trim();

    if (
      part
    ) {
      parts.push(
        part
      );
    }

    remaining =
      remaining
        .slice(
          splitAt
        )
        .trim();
  }

  if (
    remaining
  ) {
    parts.push(
      remaining
    );
  }

  return parts;
}

/* =========================================================
   ENVIAR MENSAJE TELEGRAM
========================================================= */

async function sendMessage(
  chatId: number,
  text: string
): Promise<void> {
  const cleaned =
    cleanCopilotText(
      text
    );

  if (
    !cleaned
  ) {
    return;
  }

  const parts =
    splitTelegramMessage(
      cleaned
    );

  for (
    const part of parts
  ) {
    await telegramRequest(
      "sendMessage",
      {
        chat_id:
          chatId,

        text:
          part
      }
    );
  }
}

/* =========================================================
   INDICADOR "ESCRIBIENDO"
========================================================= */

async function sendTyping(
  chatId: number
): Promise<void> {
  try {
    await telegramRequest(
      "sendChatAction",
      {
        chat_id:
          chatId,

        action:
          "typing"
      }
    );
  } catch {
    // No bloqueamos el flujo.
  }
}

/* =========================================================
   DESCARGAR FOTOGRAFÍA DE TELEGRAM
========================================================= */

async function downloadTelegramPhoto(
  photo: TelegramPhoto
): Promise<string> {
  const file =
    await telegramRequest<TelegramFile>(
      "getFile",
      {
        file_id:
          photo.file_id
      }
    );

  if (
    !file.file_path
  ) {
    throw new Error(
      "Telegram no devolvió file_path para la fotografía."
    );
  }

  const response =
    await fetch(
      `${TELEGRAM_FILE_API}/${file.file_path}`
    );

  if (
    !response.ok
  ) {
    throw new Error(
      `No se pudo descargar la fotografía: HTTP ${response.status}`
    );
  }

  const buffer =
    Buffer.from(
      await response.arrayBuffer()
    );

  await mkdir(
    TEMP_DIR,
    {
      recursive:
        true
    }
  );

  const extension =
    path.extname(
      file.file_path
    ) ||
    ".jpg";

  const fileName =
    `${Date.now()}-${photo.file_unique_id}${extension}`;

  const localPath =
    path.join(
      TEMP_DIR,
      fileName
    );

  await writeFile(
    localPath,
    buffer
  );

  return localPath;
}

/* =========================================================
   COPILOT TOKEN ENDPOINT
========================================================= */

async function getCopilotToken():
Promise<CopilotTokenResponse> {
  const response =
    await fetch(
      copilotTokenEndpoint
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Copilot Token Endpoint HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as CopilotTokenResponse;
}

/* =========================================================
   INICIAR CONVERSACIÓN DIRECT LINE
========================================================= */

async function startCopilotConversation(
  token: string
): Promise<DirectLineConversationResponse> {
  const response =
    await fetch(
      `${DIRECT_LINE}/conversations`,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${token}`,

          "Content-Type":
            "application/json"
        }
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Direct Line Start Conversation HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as DirectLineConversationResponse;
}

/* =========================================================
   LEER ACTIVIDADES
========================================================= */

async function getCopilotActivities(
  session: CopilotSession,
  watermark?: string
): Promise<DirectLineActivitySet> {
  let url =
    `${DIRECT_LINE}/conversations/${session.conversationId}/activities`;

  if (
    watermark !== undefined
  ) {
    url +=
      `?watermark=${encodeURIComponent(watermark)}`;
  }

  const response =
    await fetch(
      url,
      {
        headers: {
          Authorization:
            `Bearer ${session.token}`
        }
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Direct Line Get Activities HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as DirectLineActivitySet;
}

/* =========================================================
   REFRESCAR TOKEN DIRECT LINE
========================================================= */

async function refreshCopilotToken(
  session: CopilotSession
): Promise<void> {
  console.log(
    `[COPILOT] Renovando token: ${session.conversationId}`
  );

  const response =
    await fetch(
      `${DIRECT_LINE}/tokens/refresh`,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${session.token}`,

          "Content-Type":
            "application/json"
        }
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Direct Line Refresh Token HTTP ${response.status}: ${body}`
    );
  }

  const refreshed =
    (await response.json()) as DirectLineConversationResponse;

  if (
    !refreshed.token
  ) {
    throw new Error(
      "Direct Line no devolvió un token renovado."
    );
  }

  const expiresIn =
    refreshed.expires_in ??
    1800;

  session.token =
    refreshed.token;

  session.expiresAt =
    Date.now() +
    expiresIn * 1000;

  console.log(
    `[COPILOT] Token renovado. Expira en ${expiresIn}s`
  );
}

/* =========================================================
   CREAR SESIÓN
========================================================= */

async function createCopilotSession(
  chatId: number
): Promise<CopilotSession> {
  console.log(
    `[COPILOT] Creando sesión para chat_id=${chatId}`
  );

  const tokenResponse =
    await getCopilotToken();

  const conversation =
    await startCopilotConversation(
      tokenResponse.token
    );

  const sessionToken =
    conversation.token ??
    tokenResponse.token;

  const expiresIn =
    conversation.expires_in ??
    tokenResponse.expires_in;

  const session:
  CopilotSession = {
    token:
      sessionToken,

    conversationId:
      conversation.conversationId,

    expiresAt:
      Date.now() +
      expiresIn * 1000
  };

  await sleep(
    1500
  );

  const initial =
    await getCopilotActivities(
      session
    );

  session.watermark =
    initial.watermark;

  copilotSessions.set(
    chatId,
    session
  );

  console.log(
    `[COPILOT] Sesión creada: ${session.conversationId}`
  );

  return session;
}

/* =========================================================
   OBTENER SESIÓN
========================================================= */

async function getCopilotSession(
  chatId: number
): Promise<CopilotSession> {
  let session =
    copilotSessions.get(
      chatId
    );

  if (
    !session
  ) {
    return createCopilotSession(
      chatId
    );
  }

  const remaining =
    session.expiresAt -
    Date.now();

  if (
    remaining <= 0
  ) {
    console.log(
      `[COPILOT] Sesión expirada para chat_id=${chatId}`
    );

    copilotSessions.delete(
      chatId
    );

    return createCopilotSession(
      chatId
    );
  }

  if (
    remaining <=
    TOKEN_REFRESH_MARGIN_MS
  ) {
    try {
      await refreshCopilotToken(
        session
      );
    } catch (error) {
      console.error(
        "[COPILOT REFRESH ERROR]",
        error instanceof Error
          ? error.message
          : error
      );

      copilotSessions.delete(
        chatId
      );

      session =
        await createCopilotSession(
          chatId
        );
    }
  }

  return session;
}

/* =========================================================
   ENVIAR TEXTO A COPILOT
========================================================= */

async function sendCopilotActivity(
  session: CopilotSession,
  message: TelegramMessage,
  text: string,
  correlationId: string
): Promise<DirectLineSendResponse> {
  const url =
    `${DIRECT_LINE}/conversations/${session.conversationId}/activities`;

  const response =
    await fetch(
      url,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${session.token}`,

          "Content-Type":
            "application/json"
        },

        body:
          JSON.stringify({
            type:
              "message",

            from: {
              id:
                directLineUserId(
                  message
                ),

              name:
                technicianName(
                  message
                )
            },

            text,

            textFormat:
              "plain",

            locale:
              "es-CO",

            channelData: {
              source:
                "telegram",

              telegram_chat_id:
                message.chat.id,

              telegram_message_id:
                message.message_id,

              correlation_id:
                correlationId
            }
          })
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Direct Line Send Activity HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as DirectLineSendResponse;
}

/* =========================================================
   SUBIR FOTO + TEXTO A COPILOT
========================================================= */

async function uploadCopilotPhoto(
  session: CopilotSession,
  message: TelegramMessage,
  filePath: string,
  prompt: string,
  correlationId: string
): Promise<DirectLineSendResponse> {
  const fileInfo =
    await stat(
      filePath
    );

  if (
    fileInfo.size >
    MAX_IMAGE_SIZE
  ) {
    throw new Error(
      `La imagen excede el límite de 15 MB. ` +
      `Tamaño: ${(fileInfo.size / 1024 / 1024).toFixed(2)} MB.`
    );
  }

  const mimeType =
    getImageMimeType(
      filePath
    );

  const imageBuffer =
    await readFile(
      filePath
    );

  const imageData =
    new Uint8Array(
      imageBuffer
    );

  const imageBlob =
    new Blob(
      [
        imageData
      ],
      {
        type:
          mimeType
      }
    );

  const activity = {
    type:
      "message",

    from: {
      id:
        directLineUserId(
          message
        ),

      name:
        technicianName(
          message
        )
    },

    text:
      prompt,

    textFormat:
      "plain",

    locale:
      "es-CO",

    channelData: {
      source:
        "telegram",

      telegram_chat_id:
        message.chat.id,

      telegram_message_id:
        message.message_id,

      correlation_id:
        correlationId,

      attachment_source:
        "telegram-photo"
    }
  };

  const activityBlob =
    new Blob(
      [
        JSON.stringify(
          activity
        )
      ],
      {
        type:
          "application/vnd.microsoft.activity"
      }
    );

  const formData =
    new FormData();

  formData.append(
    "file",
    imageBlob,
    path.basename(
      filePath
    )
  );

  formData.append(
    "activity",
    activityBlob
  );

  const url =
    `${DIRECT_LINE}/conversations/${session.conversationId}/upload` +
    `?userId=${encodeURIComponent(directLineUserId(message))}`;

  const response =
    await fetch(
      url,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${session.token}`
        },

        body:
          formData
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Direct Line Upload HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as DirectLineSendResponse;
}

/* =========================================================
   ESPERAR RESPUESTA DE COPILOT
========================================================= */

async function waitForCopilotResponse(
  session: CopilotSession,
  sentActivityId: string,
  userId: string,
  sentText?: string
): Promise<string[]> {
  const deadline =
    Date.now() +
    COPILOT_TIMEOUT_MS;

  let watermark =
    session.watermark;

  while (
    Date.now() <
    deadline
  ) {
    const result =
      await getCopilotActivities(
        session,
        watermark
      );

    watermark =
      result.watermark ??
      watermark;

    session.watermark =
      watermark;

    const messages =
      result.activities
        .filter(
          (activity) => {
            if (
              activity.type !==
              "message"
            ) {
              return false;
            }

            if (
              typeof activity.text !==
              "string"
            ) {
              return false;
            }

            const text =
              activity.text.trim();

            if (
              !text
            ) {
              return false;
            }

            if (
              activity.id ===
              sentActivityId
            ) {
              return false;
            }

            if (
              activity.from?.id ===
              userId
            ) {
              return false;
            }

            if (
              sentText &&
              text ===
                sentText.trim()
            ) {
              return false;
            }

            return true;
          }
        )
        .map(
          (activity) =>
            activity.text!
              .trim()
        );

    if (
      messages.length >
      0
    ) {
      return messages;
    }

    await sleep(
      1200
    );
  }

  throw new Error(
    "Timeout esperando respuesta de FieldOps Assist."
  );
}

/* =========================================================
   ASK COPILOT - TEXTO
========================================================= */

async function askCopilot(
  message: TelegramMessage,
  text: string,
  correlationId: string
): Promise<string[]> {
  const startedAt =
    Date.now();

  const session =
    await getCopilotSession(
      message.chat.id
    );

  logEvent(
    "INFO",
    "copilot.request.started",
    {
      correlation_id:
        correlationId,

      chat_id:
        message.chat.id,

      conversation_id:
        session.conversationId,

      mode:
        "text"
    }
  );

  const sent =
    await sendCopilotActivity(
      session,
      message,
      text,
      correlationId
    );

  const responses =
    await waitForCopilotResponse(
      session,
      sent.id,
      directLineUserId(
        message
      ),
      text
    );

  logEvent(
    "INFO",
    "copilot.request.completed",
    {
      correlation_id:
        correlationId,

      chat_id:
        message.chat.id,

      conversation_id:
        session.conversationId,

      activity_id:
        sent.id,

      mode:
        "text",

      response_count:
        responses.length,

      duration_ms:
        Date.now() -
        startedAt
    }
  );

  return responses;
}

/* =========================================================
   ASK COPILOT - FOTO
========================================================= */

async function askCopilotWithPhoto(
  message: TelegramMessage,
  localPath: string,
  correlationId: string
): Promise<string[]> {
  const startedAt =
    Date.now();

  const session =
    await getCopilotSession(
      message.chat.id
    );

  const caption =
    message.caption
      ?.trim();

  const prompt =
    caption
      ? (
          `${caption}\n\n` +
          "Analiza la fotografía adjunta. " +
          "Describe primero únicamente los elementos visibles relevantes. " +
          "Si el contexto actual identifica una orden de trabajo o un modelo de panel, " +
          "relaciona lo observado únicamente con ese equipo y con su documentación técnica disponible. " +
          "No inventes texto, códigos, valores, marca o modelo que no puedan determinarse con fiabilidad."
        )
      : (
          "Analiza la fotografía adjunta. " +
          "Describe primero únicamente los elementos visibles relevantes. " +
          "Si el contexto actual identifica una orden de trabajo o un modelo de panel, " +
          "relaciona lo observado únicamente con ese equipo y con su documentación técnica disponible. " +
          "Indica las comprobaciones técnicas recomendadas cuando exista respaldo documental. " +
          "No inventes texto, códigos, valores, marca o modelo que no puedan determinarse con fiabilidad."
        );

  logEvent(
    "INFO",
    "copilot.request.started",
    {
      correlation_id:
        correlationId,

      chat_id:
        message.chat.id,

      conversation_id:
        session.conversationId,

      mode:
        "photo"
    }
  );

  const sent =
    await uploadCopilotPhoto(
      session,
      message,
      localPath,
      prompt,
      correlationId
    );

  const responses =
    await waitForCopilotResponse(
      session,
      sent.id,
      directLineUserId(
        message
      ),
      prompt
    );

  logEvent(
    "INFO",
    "copilot.request.completed",
    {
      correlation_id:
        correlationId,

      chat_id:
        message.chat.id,

      conversation_id:
        session.conversationId,

      activity_id:
        sent.id,

      mode:
        "photo",

      response_count:
        responses.length,

      duration_ms:
        Date.now() -
        startedAt
    }
  );

  return responses;
}

/* =========================================================
   HANDLE TEXT
========================================================= */

async function handleText(
  message: TelegramMessage,
  correlationId: string
): Promise<void> {
  const text =
    message.text
      ?.trim();

  if (
    !text
  ) {
    return;
  }

  if (
    text === "/start"
  ) {
    copilotSessions.delete(
      message.chat.id
    );

    logEvent(
      "INFO",
      "telegram.session.started",
      {
        correlation_id:
          correlationId,

        chat_id:
          message.chat.id,

        telegram_user_id:
          message.from?.id
      }
    );

    await sendMessage(
      message.chat.id,
      "FieldOps Assist está listo. Puede consultar órdenes de trabajo, inventario, documentación técnica y enviar fotografías para análisis."
    );

    return;
  }

  if (
    text === "/reset"
  ) {
    copilotSessions.delete(
      message.chat.id
    );

    logEvent(
      "INFO",
      "telegram.session.reset",
      {
        correlation_id:
          correlationId,

        chat_id:
          message.chat.id,

        telegram_user_id:
          message.from?.id
      }
    );

    await sendMessage(
      message.chat.id,
      "Conversación reiniciada."
    );

    return;
  }

  const inbound:
  FieldOpsInboundMessage = {
    source:
      "telegram",

    type:
      "text",

    chat_id:
      message.chat.id,

    message_id:
      message.message_id,

    technician:
      technicianFrom(
        message
      ),

    text,

    received_at:
      new Date()
        .toISOString()
  };

  logEvent(
    "INFO",
    "fieldops.inbound.normalized",
    {
      correlation_id:
        correlationId,

      source:
        inbound.source,

      message_type:
        inbound.type,

      chat_id:
        inbound.chat_id,

      message_id:
        inbound.message_id,

      telegram_user_id:
        inbound.technician.telegram_user_id
    }
  );

  await sendTyping(
    message.chat.id
  );

  const responses =
    await askCopilot(
      message,
      text,
      correlationId
    );

  for (
    const response of responses
  ) {
    await sendMessage(
      message.chat.id,
      response
    );
  }
}

/* =========================================================
   HANDLE PHOTO
========================================================= */

async function handlePhoto(
  message: TelegramMessage,
  correlationId: string
): Promise<void> {
  if (
    !message.photo ||
    message.photo.length === 0
  ) {
    return;
  }

  const largestPhoto =
    message.photo[
      message.photo.length - 1
    ];

  logEvent(
    "INFO",
    "telegram.photo.download.started",
    {
      correlation_id:
        correlationId,

      chat_id:
        message.chat.id,

      telegram_user_id:
        message.from?.id,

      telegram_file_unique_id:
        largestPhoto.file_unique_id
    }
  );

  const localPath =
    await downloadTelegramPhoto(
      largestPhoto
    );

  const inbound:
  FieldOpsInboundMessage = {
    source:
      "telegram",

    type:
      "photo",

    chat_id:
      message.chat.id,

    message_id:
      message.message_id,

    technician:
      technicianFrom(
        message
      ),

    text:
      message.caption,

    attachment: {
      telegram_file_id:
        largestPhoto.file_id,

      telegram_file_unique_id:
        largestPhoto.file_unique_id,

      width:
        largestPhoto.width,

      height:
        largestPhoto.height,

      file_size:
        largestPhoto.file_size,

      local_path:
        localPath
    },

    received_at:
      new Date()
        .toISOString()
  };

  logEvent(
    "INFO",
    "fieldops.inbound.normalized",
    {
      correlation_id:
        correlationId,

      source:
        inbound.source,

      message_type:
        inbound.type,

      chat_id:
        inbound.chat_id,

      message_id:
        inbound.message_id,

      telegram_user_id:
        inbound.technician.telegram_user_id,

      photo_width:
        largestPhoto.width,

      photo_height:
        largestPhoto.height,

      photo_size:
        largestPhoto.file_size
    }
  );

  await sendTyping(
    message.chat.id
  );

  const responses =
    await askCopilotWithPhoto(
      message,
      localPath,
      correlationId
    );

  for (
    const response of responses
  ) {
    await sendMessage(
      message.chat.id,
      response
    );
  }
}

/* =========================================================
   MESSAGE DISPATCHER
========================================================= */

async function handleMessage(
  message: TelegramMessage
): Promise<void> {
  const correlationId =
    createCorrelationId();

  const startedAt =
    Date.now();

  const messageType =
    message.photo &&
    message.photo.length > 0
      ? "photo"
      : message.text
        ? "text"
        : "unsupported";

  logEvent(
    "INFO",
    "telegram.message.received",
    {
      correlation_id:
        correlationId,

      telegram_user_id:
        message.from?.id,

      chat_id:
        message.chat.id,

      message_id:
        message.message_id,

      message_type:
        messageType
    }
  );

  try {
    if (
      !isTelegramUserAllowed(
        message
      )
    ) {
      logEvent(
        "WARN",
        "telegram.auth.denied",
        {
          correlation_id:
            correlationId,

          telegram_user_id:
            message.from?.id,

          chat_id:
            message.chat.id
        }
      );

      await sendMessage(
        message.chat.id,
        "No tiene autorización para utilizar FieldOps Assist."
      );

      return;
    }

    if (
      message.text
    ) {
      await handleText(
        message,
        correlationId
      );

      logEvent(
        "INFO",
        "telegram.message.completed",
        {
          correlation_id:
            correlationId,

          chat_id:
            message.chat.id,

          message_type:
            messageType,

          duration_ms:
            Date.now() -
            startedAt
        }
      );

      return;
    }

    if (
      message.photo &&
      message.photo.length >
        0
    ) {
      await handlePhoto(
        message,
        correlationId
      );

      logEvent(
        "INFO",
        "telegram.message.completed",
        {
          correlation_id:
            correlationId,

          chat_id:
            message.chat.id,

          message_type:
            messageType,

          duration_ms:
            Date.now() -
            startedAt
        }
      );

      return;
    }

    await sendMessage(
      message.chat.id,
      "Por ahora puedo procesar mensajes de texto y fotografías."
    );

    logEvent(
      "WARN",
      "telegram.message.unsupported",
      {
        correlation_id:
          correlationId,

        chat_id:
          message.chat.id,

        message_type:
          messageType,

        duration_ms:
          Date.now() -
          startedAt
      }
    );
  } catch (error) {
    logEvent(
      "ERROR",
      "telegram.message.failed",
      {
        correlation_id:
          correlationId,

        telegram_user_id:
          message.from?.id,

        chat_id:
          message.chat.id,

        message_type:
          messageType,

        duration_ms:
          Date.now() -
          startedAt,

        error:
          error instanceof Error
            ? error.message
            : String(error)
      }
    );

    try {
      await sendMessage(
        message.chat.id,
        "No pude procesar la solicitud en este momento. Inténtelo nuevamente."
      );
    } catch (sendError) {
      logEvent(
        "ERROR",
        "telegram.error_message.failed",
        {
          correlation_id:
            correlationId,

          chat_id:
            message.chat.id,

          error:
            sendError instanceof Error
              ? sendError.message
              : String(sendError)
        }
      );
    }
  }
}

/* =========================================================
   TELEGRAM WEBHOOK
========================================================= */

const app =
  express();

app.disable(
  "x-powered-by"
);

app.use(
  express.json({
    limit:
      "2mb"
  })
);

app.get(
  "/health",
  (
    _req: Request,
    res: Response
  ) => {
    res
      .status(
        200
      )
      .json({
        status:
          "ok",

        service:
          "fieldops-telegram-relay",

        telegram:
          "webhook",

        copilot:
          "direct-line",

        vision:
          "enabled"
      });
  }
);

app.post(
  "/telegram/webhook",
  (
    req: Request,
    res: Response
  ) => {
    const receivedSecret =
      req.get(
        "X-Telegram-Bot-Api-Secret-Token"
      );

    if (
      receivedSecret !==
      telegramWebhookSecret
    ) {
      logEvent(
        "WARN",
        "telegram.webhook.secret_rejected"
      );

      res.sendStatus(
        401
      );

      return;
    }

    const update =
      req.body as TelegramUpdate;

    if (
      !update ||
      typeof update.update_id !==
        "number"
    ) {
      logEvent(
        "WARN",
        "telegram.webhook.invalid_update"
      );

      res.sendStatus(
        400
      );

      return;
    }

    /*
     * Confirmamos rápidamente a Telegram.
     * El procesamiento continúa después.
     */
    res.sendStatus(
      200
    );

    logEvent(
      "INFO",
      "telegram.webhook.update_received",
      {
        update_id:
          update.update_id,

        has_message:
          Boolean(
            update.message
          )
      }
    );

    if (
      !update.message
    ) {
      return;
    }

    void handleMessage(
      update.message
    ).catch(
      (error) => {
        logEvent(
          "ERROR",
          "telegram.webhook.processing_failed",
          {
            update_id:
              update.update_id,

            error:
              error instanceof Error
                ? error.message
                : String(error)
          }
        );
      }
    );
  }
);

/* =========================================================
   MAIN
========================================================= */

async function main():
Promise<void> {
  await mkdir(
    TEMP_DIR,
    {
      recursive:
        true
    }
  );

  const bot =
    await telegramRequest<TelegramUser>(
      "getMe"
    );

  console.log(
    "--------------------------------"
  );

  console.log(
    "FieldOps Assist Relay"
  );

  console.log(
    "--------------------------------"
  );

  console.log(
    `Bot: ${bot.first_name}`
  );

  console.log(
    `Username: @${bot.username ?? "sin_username"}`
  );

  console.log(
    `Bot ID: ${bot.id}`
  );

  console.log(
    `Temp: ${TEMP_DIR}`
  );

  console.log(
    "Copilot: Direct Line habilitado"
  );

  console.log(
    "Vision: Direct Line Upload habilitado"
  );

  console.log(
    "Sesiones: una por chat_id"
  );

  console.log(
    "Telegram: Webhook"
  );

  console.log(
    `Usuarios autorizados: ${telegramAllowedUserIds.size}`
  );

  console.log(
    `Puerto: ${PORT}`
  );

  console.log(
    "--------------------------------"
  );

  logEvent(
    "INFO",
    "relay.started",
    {
      port:
        PORT,

      telegram_mode:
        "webhook",

      copilot:
        "direct-line",

      vision:
        true,

      allowed_user_count:
        telegramAllowedUserIds.size
    }
  );

  app.listen(
    PORT,
    () => {
      console.log(
        `Relay escuchando en puerto ${PORT}`
      );
    }
  );
}

/* =========================================================
   EJECUCIÓN
========================================================= */

main().catch(
  (error) => {
    logEvent(
      "ERROR",
      "relay.startup.failed",
      {
        error:
          error instanceof Error
            ? error.message
            : String(error)
      }
    );

    process.exit(
      1
    );
  }
);