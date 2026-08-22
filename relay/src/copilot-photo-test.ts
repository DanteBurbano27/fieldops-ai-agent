import "dotenv/config";

import {
  readFile,
  readdir,
  stat
} from "node:fs/promises";

import path from "node:path";

/* =========================================================
   CONFIGURACIÓN
========================================================= */

function requireEnv(
  name: string
): string {
  const value =
    process.env[name];

  if (!value) {
    throw new Error(
      `Falta ${name}. Revisa el archivo .env.`
    );
  }

  return value;
}

const copilotTokenEndpoint =
  requireEnv(
    "COPILOT_TOKEN_ENDPOINT"
  );

const DIRECT_LINE =
  "https://directline.botframework.com/v3/directline";

const PHOTO_DIR =
  path.resolve(
    "tmp",
    "telegram"
  );

const TEST_USER_ID =
  "telegram-photo-test";

const RESPONSE_TIMEOUT_MS =
  90_000;

const MAX_FILE_SIZE =
  15 * 1024 * 1024;

/* =========================================================
   TIPOS
========================================================= */

interface CopilotTokenResponse {
  token: string;
  expires_in: number;
  conversationId: string;
}

interface ConversationResponse {
  conversationId: string;
  token?: string;
  expires_in?: number;
  streamUrl?: string;
}

interface SendActivityResponse {
  id: string;
}

interface Activity {
  id?: string;
  type: string;

  from?: {
    id?: string;
    name?: string;
  };

  text?: string;
}

interface ActivitySet {
  activities: Activity[];
  watermark?: string;
}

/* =========================================================
   UTILIDADES
========================================================= */

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

function getMimeType(
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
   BUSCAR FOTO MÁS RECIENTE
========================================================= */

async function getLatestPhoto():
Promise<string> {
  const files =
    await readdir(
      PHOTO_DIR
    );

  const candidates:
  {
    filePath: string;
    modified: number;
  }[] = [];

  for (
    const file of files
  ) {
    const filePath =
      path.join(
        PHOTO_DIR,
        file
      );

    const extension =
      path
        .extname(filePath)
        .toLowerCase();

    if (
      ![
        ".jpg",
        ".jpeg",
        ".png",
        ".webp",
        ".gif"
      ].includes(extension)
    ) {
      continue;
    }

    const info =
      await stat(filePath);

    if (
      !info.isFile()
    ) {
      continue;
    }

    candidates.push({
      filePath,
      modified:
        info.mtimeMs
    });
  }

  if (
    candidates.length === 0
  ) {
    throw new Error(
      `No hay fotografías en ${PHOTO_DIR}`
    );
  }

  candidates.sort(
    (a, b) =>
      b.modified -
      a.modified
  );

  return candidates[0].filePath;
}

/* =========================================================
   TOKEN COPILOT
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
      `Token Endpoint HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as CopilotTokenResponse;
}

/* =========================================================
   INICIAR CONVERSACIÓN
========================================================= */

async function startConversation(
  token: string
): Promise<ConversationResponse> {
  const response =
    await fetch(
      `${DIRECT_LINE}/conversations`,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${token}`
        }
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Start Conversation HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as ConversationResponse;
}

/* =========================================================
   LEER ACTIVIDADES
========================================================= */

async function getActivities(
  token: string,
  conversationId: string,
  watermark?: string
): Promise<ActivitySet> {
  let url =
    `${DIRECT_LINE}/conversations/${conversationId}/activities`;

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
            `Bearer ${token}`
        }
      }
    );

  if (
    !response.ok
  ) {
    const body =
      await response.text();

    throw new Error(
      `Get Activities HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as ActivitySet;
}

/* =========================================================
   SUBIR IMAGEN + TEXTO EN UNA MISMA ACTIVIDAD
========================================================= */

async function uploadPhotoActivity(
  token: string,
  conversationId: string,
  filePath: string,
  text: string
): Promise<SendActivityResponse> {
  const fileInfo =
    await stat(
      filePath
    );

  if (
    fileInfo.size >
    MAX_FILE_SIZE
  ) {
    throw new Error(
      `La imagen pesa ${(fileInfo.size / 1024 / 1024).toFixed(2)} MB. ` +
      "Copilot Studio admite hasta 15 MB por archivo."
    );
  }

  const mimeType =
    getMimeType(
      filePath
    );

  const fileName =
    path.basename(
      filePath
    );

  const imageBuffer =
    await readFile(
      filePath
    );

  const imageBlob =
    new Blob(
      [imageBuffer],
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
        TEST_USER_ID,

      name:
        "Telegram Photo Test"
    },

    text,

    textFormat:
      "plain",

    locale:
      "es-CO"
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

  /*
   * Microsoft Direct Line agrega los archivos
   * del multipart como attachments de esta Activity.
   */
  formData.append(
    "file",
    imageBlob,
    fileName
  );

  formData.append(
    "activity",
    activityBlob
  );

  const url =
    `${DIRECT_LINE}/conversations/${conversationId}/upload` +
    `?userId=${encodeURIComponent(TEST_USER_ID)}`;

  const response =
    await fetch(
      url,
      {
        method:
          "POST",

        headers: {
          Authorization:
            `Bearer ${token}`
        },

        /*
         * NO colocar Content-Type manualmente.
         * Node genera automáticamente el boundary
         * correcto de multipart/form-data.
         */
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
      `Upload HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as SendActivityResponse;
}

/* =========================================================
   ESPERAR RESPUESTA
========================================================= */

async function waitForResponse(
  token: string,
  conversationId: string,
  sentActivityId: string,
  initialWatermark?: string
): Promise<string[]> {
  const deadline =
    Date.now() +
    RESPONSE_TIMEOUT_MS;

  let watermark =
    initialWatermark;

  while (
    Date.now() <
    deadline
  ) {
    const result =
      await getActivities(
        token,
        conversationId,
        watermark
      );

    watermark =
      result.watermark ??
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

            if (
              activity.text
                .trim()
                .length === 0
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
              TEST_USER_ID
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
      1500
    );
  }

  throw new Error(
    "Timeout esperando respuesta de FieldOps Assist."
  );
}

/* =========================================================
   MAIN
========================================================= */

async function main():
Promise<void> {
  console.log(
    "1. Buscando fotografía más reciente..."
  );

  const photoPath =
    await getLatestPhoto();

  const photoInfo =
    await stat(
      photoPath
    );

  console.log(
    `   Archivo: ${photoPath}`
  );

  console.log(
    `   Tamaño: ${(photoInfo.size / 1024).toFixed(1)} KB`
  );

  console.log(
    `   MIME: ${getMimeType(photoPath)}`
  );

  console.log(
    "2. Obteniendo token de Copilot..."
  );

  const tokenResponse =
    await getCopilotToken();

  console.log(
    `   Token obtenido. Expira en ${tokenResponse.expires_in}s`
  );

  console.log(
    "3. Iniciando conversación Direct Line..."
  );

  const conversation =
    await startConversation(
      tokenResponse.token
    );

  const token =
    conversation.token ??
    tokenResponse.token;

  const conversationId =
    conversation.conversationId;

  console.log(
    `   conversationId: ${conversationId}`
  );

  console.log(
    "4. Inicializando conversación..."
  );

  await sleep(
    1500
  );

  const initial =
    await getActivities(
      token,
      conversationId
    );

  const initialWatermark =
    initial.watermark;

  console.log(
    `   Watermark inicial: ${initialWatermark ?? "ninguno"}`
  );

  const prompt =
    "Describe únicamente lo que puedes observar en esta fotografía. " +
    "No infieras información que no sea visible. " +
    "Si no puedes determinar marca o modelo con fiabilidad, indícalo explícitamente.";

  console.log(
    "5. Subiendo fotografía a FieldOps Assist..."
  );

  const sent =
    await uploadPhotoActivity(
      token,
      conversationId,
      photoPath,
      prompt
    );

  console.log(
    `   Activity ID: ${sent.id}`
  );

  console.log(
    "6. Esperando análisis visual..."
  );

  const responses =
    await waitForResponse(
      token,
      conversationId,
      sent.id,
      initialWatermark
    );

  console.log(
    "\n========================================"
  );

  console.log(
    "RESPUESTA VISUAL FIELDOPS ASSIST"
  );

  console.log(
    "========================================\n"
  );

  for (
    const response of responses
  ) {
    console.log(
      response
    );

    console.log();
  }

  console.log(
    "========================================"
  );

  console.log(
    "PRUEBA DE FOTO COMPLETADA"
  );

  console.log(
    "========================================"
  );
}

main().catch(
  (error) => {
    console.error(
      "\nERROR:",
      error instanceof Error
        ? error.message
        : error
    );

    process.exit(1);
  }
);