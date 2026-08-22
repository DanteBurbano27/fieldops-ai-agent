import "dotenv/config";

const tokenEndpointRaw =
  process.env.COPILOT_TOKEN_ENDPOINT;

if (!tokenEndpointRaw) {
  throw new Error(
    "Falta COPILOT_TOKEN_ENDPOINT en .env"
  );
}

const tokenEndpoint: string =
  tokenEndpointRaw;

const DIRECT_LINE =
  "https://directline.botframework.com/v3/directline";

interface TokenResponse {
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
    role?: string;
  };
  text?: string;
}

interface ActivitySet {
  activities: Activity[];
  watermark?: string;
}

function sleep(
  ms: number
): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function getCopilotToken():
Promise<TokenResponse> {
  const response =
    await fetch(tokenEndpoint);

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Token endpoint HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as TokenResponse;
}

async function startConversation(
  token: string
): Promise<ConversationResponse> {
  const response =
    await fetch(
      `${DIRECT_LINE}/conversations`,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${token}`,
          "Content-Type":
            "application/json"
        }
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Start conversation HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as ConversationResponse;
}

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

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Get activities HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as ActivitySet;
}

async function sendActivity(
  token: string,
  conversationId: string,
  text: string
): Promise<SendActivityResponse> {
  const url =
    `${DIRECT_LINE}/conversations/${conversationId}/activities`;

  const response =
    await fetch(
      url,
      {
        method: "POST",
        headers: {
          Authorization:
            `Bearer ${token}`,
          "Content-Type":
            "application/json"
        },
        body: JSON.stringify({
          type: "message",
          from: {
            id: "relay-test-user",
            name: "Relay Test User"
          },
          text,
          textFormat: "plain",
          locale: "es-CO"
        })
      }
    );

  if (!response.ok) {
    const body =
      await response.text();

    throw new Error(
      `Send activity HTTP ${response.status}: ${body}`
    );
  }

  return (
    await response.json()
  ) as SendActivityResponse;
}

async function waitForBotResponse(
  token: string,
  conversationId: string,
  sentActivityId: string,
  sentText: string,
  initialWatermark?: string
): Promise<string[]> {
  const deadline =
    Date.now() + 60000;

  let watermark =
    initialWatermark;

  while (
    Date.now() < deadline
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

    const botMessages =
      result.activities
        .filter((activity) => {
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

          if (!text) {
            return false;
          }

          if (
            activity.id ===
            sentActivityId
          ) {
            return false;
          }

          if (
            text ===
            sentText.trim()
          ) {
            return false;
          }

          if (
            activity.from?.id ===
            "relay-test-user"
          ) {
            return false;
          }

          return true;
        })
        .map((activity) =>
          activity.text!.trim()
        );

    if (
      botMessages.length > 0
    ) {
      return botMessages;
    }

    await sleep(1500);
  }

  throw new Error(
    "Timeout esperando respuesta de FieldOps Assist"
  );
}

async function main():
Promise<void> {
  const testMessage =
    "Consulta la orden de trabajo OT-1042.";

  console.log(
    "1. Obteniendo token de Copilot..."
  );

  const tokenResponse =
    await getCopilotToken();

  console.log(
    `   Token obtenido. Expira en ${tokenResponse.expires_in}s`
  );

  console.log(
    "2. Iniciando conversación Direct Line..."
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
    "3. Inicializando sesión..."
  );

  await sleep(2000);

  const initialActivities =
    await getActivities(
      token,
      conversationId
    );

  const initialWatermark =
    initialActivities.watermark;

  console.log(
    `   Watermark inicial: ${
      initialWatermark ??
      "ninguno"
    }`
  );

  console.log(
    "4. Enviando mensaje..."
  );

  console.log(
    `   > ${testMessage}`
  );

  const sent =
    await sendActivity(
      token,
      conversationId,
      testMessage
    );

  console.log(
    `   Activity ID: ${sent.id}`
  );

  console.log(
    "5. Esperando respuesta de FieldOps Assist..."
  );

  const responses =
    await waitForBotResponse(
      token,
      conversationId,
      sent.id,
      testMessage,
      initialWatermark
    );

  console.log(
    "\n========================================"
  );

  console.log(
    "RESPUESTA DE FIELDOPS ASSIST"
  );

  console.log(
    "========================================\n"
  );

  for (
    const response of responses
  ) {
    console.log(response);
    console.log();
  }

  console.log(
    "========================================"
  );

  console.log(
    "PRUEBA COMPLETADA"
  );

  console.log(
    "========================================"
  );
}

main().catch((error) => {
  console.error(
    "\nERROR:",
    error instanceof Error
      ? error.message
      : error
  );

  process.exit(1);
});