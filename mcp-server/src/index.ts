import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

function createServer() {
  const server = new McpServer({
    name: "fieldops-mcp",
    version: "1.0.0"
  });

  server.registerTool(
    "get_work_order",
    {
      title: "Get Work Order",
      description: "Obtiene una orden de trabajo de FieldOps por su identificador.",
      inputSchema: {
        work_order_id: z.string().min(1)
      }
    },
    async ({ work_order_id }) => {
      const filePath = path.resolve(
        process.cwd(),
        "../data/seed/work-orders.json"
      );

      const raw = await fs.readFile(filePath, "utf8");
      const workOrders = JSON.parse(raw) as Array<Record<string, unknown>>;

      const workOrder = workOrders.find(
        (item) => item.work_order_id === work_order_id
      );

      if (!workOrder) {
        return {
          content: [
            {
              type: "text",
              text: `No se encontró la orden ${work_order_id}.`
            }
          ],
          isError: true
        };
      }

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(workOrder)
          }
        ],
        structuredContent: workOrder
      };
    }
  );

  return server;
}
const app = createMcpExpressApp();
const port = Number(process.env.PORT ?? 3000);

app.get("/health", (_req: Request, res: Response) => {
  res.status(200).json({
    status: "ok",
    service: "fieldops-mcp"
  });
});

app.post("/mcp", async (req: Request, res: Response) => {
  const server = createServer();

  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on("close", () => {
      void transport.close();
      void server.close();
    });
  } catch (error) {
    console.error("MCP request failed:", error);

    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: {
          code: -32603,
          message: "Internal server error"
        },
        id: null
      });
    }
  }
});

app.get("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed"
    },
    id: null
  });
});

app.delete("/mcp", (_req: Request, res: Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: {
      code: -32000,
      message: "Method not allowed"
    },
    id: null
  });
});

app.listen(port, "0.0.0.0", () => {
  console.log(`FieldOps MCP listening on port ${port}`);
});