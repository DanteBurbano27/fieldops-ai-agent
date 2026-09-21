export type RelayConfig = {
  telegramToken: string;
  copilotTokenEndpoint: string;
  telegramWebhookSecret: string;
  telegramAllowedUserIds: Set<number>;
  port: number;
};

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Falta ${name}. Revisa el archivo .env.`);
  }
  return value;
}

export function loadRelayConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const allowedRaw = required(env, "TELEGRAM_ALLOWED_USER_IDS");
  const allowedValues = allowedRaw.split(",").map((value) => value.trim());
  const invalid = allowedValues.filter(
    (value) => !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))
  );

  if (invalid.length > 0) {
    throw new Error("TELEGRAM_ALLOWED_USER_IDS contiene identificadores inválidos.");
  }

  const port = Number(env.PORT ?? 3000);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT debe ser un puerto TCP válido.");
  }

  return {
    telegramToken: required(env, "TELEGRAM_BOT_TOKEN"),
    copilotTokenEndpoint: required(env, "COPILOT_TOKEN_ENDPOINT"),
    telegramWebhookSecret: required(env, "TELEGRAM_WEBHOOK_SECRET"),
    telegramAllowedUserIds: new Set(allowedValues.map(Number)),
    port
  };
}
