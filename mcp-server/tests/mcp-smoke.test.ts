import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const PORT = 31337;
const API_KEY = "fieldops-test-api-key";
const MCP_URL = new URL(`http://127.0.0.1:${PORT}/mcp`);
let dataDir = "";
let serverProcess: ChildProcess;

async function waitForServer(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/health`);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("MCP test server did not start");
}

async function createClient() {
  const client = new Client({ name: "fieldops-test", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(MCP_URL, {
    requestInit: { headers: { Authorization: `Bearer ${API_KEY}` } }
  });
  await client.connect(transport);
  return client;
}

async function callTool(name: string, args: Record<string, unknown>) {
  const client = await createClient();
  try {
    return await client.callTool({ name, arguments: args });
  } finally {
    await client.close();
  }
}

async function interventions(): Promise<Array<Record<string, unknown>>> {
  return JSON.parse(await readFile(path.join(dataDir, "interventions.json"), "utf8"));
}

function registration(overrides: Record<string, unknown> = {}) {
  return {
    work_order_id: "OT-1042",
    technician_id: "TEC-001",
    action_summary: "Replaced backup battery",
    result: "Panel restored",
    confirmed: true,
    idempotency_key: "test-key-0001",
    correlation_id: "corr-test-0001",
    ...overrides
  };
}

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "fieldops-mcp-"));
  for (const file of ["work-orders.json", "technicians.json", "inventory.json"]) {
    await copyFile(path.resolve("../data/seed", file), path.join(dataDir, file));
  }
  await writeFile(path.join(dataDir, "interventions.json"), "[]\n", "utf8");
  serverProcess = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      FIELDOPS_DATA_DIR: dataDir,
      FIELDOPS_MCP_API_KEY: API_KEY
    },
    stdio: "ignore"
  });
  await waitForServer();
});

after(async () => {
  serverProcess.kill();
  await rm(dataDir, { recursive: true, force: true });
});

test("health endpoint responds without authentication", async () => {
  const response = await fetch(`http://127.0.0.1:${PORT}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", service: "fieldops-mcp" });
});

test("MCP endpoint rejects requests without a bearer token", async () => {
  const response = await fetch(MCP_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream"
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" })
  });
  assert.equal(response.status, 401);
});

test("MCP exposes expected tools", async () => {
  const client = await createClient();
  try {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    assert.deepEqual(names.sort(), ["check_inventory", "get_work_order", "register_intervention"]);
  } finally {
    await client.close();
  }
});

test("get_work_order returns the seeded order", async () => {
  const result = await callTool("get_work_order", { work_order_id: "OT-1042" });
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as Record<string, unknown>).technician_id, "TEC-001");
});

test("get_work_order rejects an unknown order", async () => {
  assert.equal((await callTool("get_work_order", { work_order_id: "OT-9999" })).isError, true);
});

test("check_inventory distinguishes availability", async () => {
  const available = await callTool("check_inventory", { work_order_id: "OT-1042", part_number: "BAT-12V7AH" });
  const unavailable = await callTool("check_inventory", { work_order_id: "OT-2040", part_number: "BAT-12V7AH" });
  assert.equal((available.structuredContent as Record<string, unknown>).available, true);
  assert.equal((unavailable.structuredContent as Record<string, unknown>).available, false);
});

test("register_intervention requires explicit confirmation", async () => {
  assert.equal((await callTool("register_intervention", registration({ confirmed: false }))).isError, true);
});

test("register_intervention rejects an unknown work order", async () => {
  assert.equal((await callTool("register_intervention", registration({ work_order_id: "OT-9999" }))).isError, true);
});

test("register_intervention rejects an unknown technician", async () => {
  assert.equal((await callTool("register_intervention", registration({ technician_id: "TEC-999" }))).isError, true);
});

test("register_intervention rejects a technician not assigned to the order", async () => {
  assert.equal((await callTool("register_intervention", registration({ technician_id: "TEC-002" }))).isError, true);
});

test("register_intervention persists a valid registration", async () => {
  const result = await callTool("register_intervention", registration());
  assert.equal(result.isError, undefined);
  assert.equal((result.structuredContent as Record<string, unknown>).idempotent_replay, false);
  assert.equal((await interventions()).length, 1);
});

test("idempotent replay returns the existing intervention without a duplicate write", async () => {
  const result = await callTool("register_intervention", registration({ correlation_id: "corr-retry" }));
  assert.equal((result.structuredContent as Record<string, unknown>).idempotent_replay, true);
  assert.equal((await interventions()).filter((item) => item.idempotency_key === "test-key-0001").length, 1);
});

test("reusing an idempotency key for a different operation fails", async () => {
  const result = await callTool("register_intervention", registration({ result: "Different result" }));
  assert.equal(result.isError, true);
  assert.equal((await interventions()).length, 1);
});

test("concurrent writes are serialized without lost or duplicate physical writes", async () => {
  const count = 12;
  const results = await Promise.all(
    Array.from({ length: count }, (_, index) =>
      callTool("register_intervention", registration({
        action_summary: `Concurrent action ${index}`,
        result: `Concurrent result ${index}`,
        idempotency_key: `concurrent-key-${String(index).padStart(2, "0")}`,
        correlation_id: `concurrent-corr-${index}`
      }))
    )
  );
  assert.ok(results.every((result) => result.isError === undefined));
  const stored = await interventions();
  assert.equal(stored.length, 1 + count);
  assert.equal(new Set(stored.map((item) => item.idempotency_key)).size, stored.length);
});
