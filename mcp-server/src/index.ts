import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";

type WorkOrderRecord = {
  work_order_id: string;
  site_id: string;
  equipment_model: string;
};

type InventoryRecord = {
  site_id: string;
  part_number: string;
  description: string;
  compatible_with: string[];
  quantity: number;
};

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
    server.registerTool(
    "check_inventory",
    {
      title: "Check Inventory",
      description:
        "Consulta disponibilidad y compatibilidad de un repuesto para una orden de trabajo.",
      inputSchema: {
        work_order_id: z.string().min(1),
        part_number: z.string().min(1)
      }
    },
    async ({ work_order_id, part_number }) => {
      const workOrdersPath = path.resolve(
        process.cwd(),
        "../data/seed/work-orders.json"
      );

      const inventoryPath = path.resolve(
        process.cwd(),
        "../data/seed/inventory.json"
      );

      const [workOrdersRaw, inventoryRaw] = await Promise.all([
        fs.readFile(workOrdersPath, "utf8"),
        fs.readFile(inventoryPath, "utf8")
      ]);

      const workOrders = JSON.parse(workOrdersRaw) as WorkOrderRecord[];
      const inventory = JSON.parse(inventoryRaw) as InventoryRecord[];

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

      const inventoryItem = inventory.find(
        (item) =>
          item.site_id === workOrder.site_id &&
          item.part_number === part_number
      );

      if (!inventoryItem) {
        return {
          content: [
            {
              type: "text",
              text:
                `No se encontró el repuesto ${part_number} ` +
                `en el inventario del sitio ${workOrder.site_id}.`
            }
          ],
          isError: true
        };
      }

      const result = {
        work_order_id: workOrder.work_order_id,
        site_id: workOrder.site_id,
        equipment_model: workOrder.equipment_model,
        part_number: inventoryItem.part_number,
        description: inventoryItem.description,
        quantity: inventoryItem.quantity,
        compatible: inventoryItem.compatible_with.includes(
          workOrder.equipment_model
        ),
        available: inventoryItem.quantity > 0
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(result)
          }
        ],
        structuredContent: result
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