import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID } from "node:crypto";

type WorkOrderRecord = {
  work_order_id: string;
  site_id: string;
  equipment_model: string;
  technician_id: string;
};

type InventoryRecord = {
  site_id: string;
  part_number: string;
  description: string;
  compatible_with: string[];
  quantity: number;
};

type TechnicianRecord = {
  technician_id: string;
  name: string;
  skills: string[];
  status: string;
};

type InterventionRecord = {
  intervention_id: string;
  work_order_id: string;
  site_id: string;
  technician_id: string;
  technician_name: string;
  action_summary: string;
  result: string;
  idempotency_key: string;
  correlation_id: string;
  created_at: string;
};

let interventionWriteQueue: Promise<void> = Promise.resolve();

async function withInterventionWriteLock<T>(
  operation: () => Promise<T>
): Promise<T> {
  const previousWrite = interventionWriteQueue;

  let release!: () => void;

  interventionWriteQueue = new Promise<void>((resolve) => {
    release = resolve;
  });

  await previousWrite;

  try {
    return await operation();
  } finally {
    release();
  }
}

const dataDir = process.env.FIELDOPS_DATA_DIR
  ? path.resolve(process.env.FIELDOPS_DATA_DIR)
  : path.resolve(process.cwd(), "../data/seed");

function dataFile(fileName: string): string {
  return path.join(dataDir, fileName);
}

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
      const filePath = dataFile("work-orders.json");
      

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
     const workOrdersPath = dataFile("work-orders.json");
     const inventoryPath = dataFile("inventory.json");
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
    server.registerTool(
    "register_intervention",
    {
      title: "Register Intervention",
      description:
        "Registra una intervención confirmada para una orden de trabajo, con idempotencia y trazabilidad.",
      inputSchema: {
        work_order_id: z.string().min(1),
        technician_id: z.string().min(1),
        action_summary: z.string().min(3).max(500),
        result: z.string().min(3).max(500),
        confirmed: z.boolean(),
        idempotency_key: z.string().min(8).max(128),
        correlation_id: z.string().min(1).max(128)
      }
    },
    async ({
      work_order_id,
      technician_id,
      action_summary,
      result,
      confirmed,
      idempotency_key,
      correlation_id
    }) => {
      if (!confirmed) {
        return {
          content: [
            {
              type: "text",
              text:
                "La intervención no fue registrada porque falta confirmación explícita."
            }
          ],
          isError: true
        };
      }

      const workOrdersPath = dataFile("work-orders.json");
      const techniciansPath = dataFile("technicians.json");
      const interventionsPath = dataFile("interventions.json");

      const [workOrdersRaw, techniciansRaw] = await Promise.all([
        fs.readFile(workOrdersPath, "utf8"),
        fs.readFile(techniciansPath, "utf8")
      ]);

      const workOrders = JSON.parse(workOrdersRaw) as WorkOrderRecord[];
      const technicians = JSON.parse(techniciansRaw) as TechnicianRecord[];

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

      const technician = technicians.find(
        (item) => item.technician_id === technician_id
      );

      if (!technician) {
        return {
          content: [
            {
              type: "text",
              text: `No se encontró el técnico ${technician_id}.`
            }
          ],
          isError: true
        };
      }

      if (workOrder.technician_id !== technician_id) {
        return {
          content: [
            {
              type: "text",
              text:
                `El técnico ${technician_id} no está asignado ` +
                `a la orden ${work_order_id}.`
            }
          ],
          isError: true
        };
      }

      return withInterventionWriteLock(async () => {
        const interventionsRaw = await fs.readFile(
          interventionsPath,
          "utf8"
        );

        const interventions = JSON.parse(
          interventionsRaw
        ) as InterventionRecord[];

        const existingIntervention = interventions.find(
          (item) => item.idempotency_key === idempotency_key
        );

        if (existingIntervention) {
          const sameOperation =
            existingIntervention.work_order_id === work_order_id &&
            existingIntervention.technician_id === technician_id &&
            existingIntervention.action_summary === action_summary &&
            existingIntervention.result === result;

          if (!sameOperation) {
            return {
              content: [
                {
                  type: "text" as const,
                  text:
                    "La idempotency_key ya fue utilizada para una intervención diferente."
                }
              ],
              isError: true
            };
          }

          const replayResult = {
            ...existingIntervention,
            idempotent_replay: true
          };

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify(replayResult)
              }
            ],
            structuredContent: replayResult
          };
        }

        const intervention: InterventionRecord = {
          intervention_id: `INT-${randomUUID()}`,
          work_order_id,
          site_id: workOrder.site_id,
          technician_id,
          technician_name: technician.name,
          action_summary,
          result,
          idempotency_key,
          correlation_id,
          created_at: new Date().toISOString()
        };

        interventions.push(intervention);

        await fs.writeFile(
          interventionsPath,
          JSON.stringify(interventions, null, 2) + "\n",
          "utf8"
        );

        const registrationResult = {
          ...intervention,
          idempotent_replay: false
        };

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(registrationResult)
            }
          ],
          structuredContent: registrationResult
        };
      });
    }
  );

  return server;
}
const app = createMcpExpressApp({
  host: "0.0.0.0",
  allowedHosts: [
    "fieldops-mcp-danielb-260815.azurewebsites.net",
    "localhost",
    "127.0.0.1"
  ]
});

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