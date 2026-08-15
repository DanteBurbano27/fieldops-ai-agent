import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_URL = new URL("http://localhost:3000/mcp");

async function createClient() {
  const client = new Client({
    name: "fieldops-smoke-test",
    version: "1.0.0"
  });

  const transport = new StreamableHTTPClientTransport(MCP_URL);

  await client.connect(transport);

  return client;
}

test("health endpoint responds ok", async () => {
  const response = await fetch("http://localhost:3000/health");

  assert.equal(response.status, 200);

  const body = await response.json();

  assert.deepEqual(body, {
    status: "ok",
    service: "fieldops-mcp"
  });
});

test("MCP exposes expected tools", async () => {
  const client = await createClient();

  try {
    const result = await client.listTools();

    const toolNames = result.tools.map((tool) => tool.name);

    assert.ok(toolNames.includes("get_work_order"));
    assert.ok(toolNames.includes("check_inventory"));
    assert.ok(toolNames.includes("register_intervention"));
  } finally {
    await client.close();
  }
});

test("get_work_order returns OT-1042", async () => {
  const client = await createClient();

  try {
    const result = await client.callTool({
      name: "get_work_order",
      arguments: {
        work_order_id: "OT-1042"
      }
    });

    assert.equal(result.isError, undefined);

    const data = result.structuredContent as Record<string, unknown>;

    assert.equal(data.work_order_id, "OT-1042");
    assert.equal(data.site_id, "SITE-BOG-01");
    assert.equal(data.equipment_model, "VISTA-48LA");
    assert.equal(data.technician_id, "TEC-001");
  } finally {
    await client.close();
  }
});

test("get_work_order rejects unknown order", async () => {
  const client = await createClient();

  try {
    const result = await client.callTool({
      name: "get_work_order",
      arguments: {
        work_order_id: "OT-9999"
      }
    });

    assert.equal(result.isError, true);
  } finally {
    await client.close();
  }
});

test("check_inventory distinguishes stock availability", async () => {
  const client = await createClient();

  try {
    const availableResult = await client.callTool({
      name: "check_inventory",
      arguments: {
        work_order_id: "OT-1042",
        part_number: "BAT-12V7AH"
      }
    });

    const available =
      availableResult.structuredContent as Record<string, unknown>;

    assert.equal(available.quantity, 3);
    assert.equal(available.compatible, true);
    assert.equal(available.available, true);

    const unavailableResult = await client.callTool({
      name: "check_inventory",
      arguments: {
        work_order_id: "OT-2040",
        part_number: "BAT-12V7AH"
      }
    });

    const unavailable =
      unavailableResult.structuredContent as Record<string, unknown>;

    assert.equal(unavailable.quantity, 0);
    assert.equal(unavailable.compatible, true);
    assert.equal(unavailable.available, false);
  } finally {
    await client.close();
  }
});