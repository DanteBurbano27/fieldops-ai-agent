import { randomUUID } from "node:crypto";

export function createCorrelationId(): string {
  return randomUUID();
}
