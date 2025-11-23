import cors from "cors";
import express from "express";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CONFIG_PATH = process.env.MCP_GATEWAY_CONFIG ?? path.join(__dirname, "servers_config.json");
const SERVER_NAME = process.env.MCP_GATEWAY_NAME ?? "magenticx-mcp-gateway";
const SERVER_VERSION = process.env.MCP_GATEWAY_VERSION ?? "0.1.0";
const PORT = Number(process.env.MCP_GATEWAY_PORT ?? process.env.PORT ?? 8080);
const SSE_PATH = process.env.MCP_GATEWAY_SSE_PATH ?? "/sse";
const MESSAGES_PATH = process.env.MCP_GATEWAY_MESSAGES_PATH ?? "/messages";

const aggregatorServer = new McpServer({
  name: SERVER_NAME,
  version: SERVER_VERSION,
});

const activeClients = new Map();
const registeredTools = new Set();
let activeTransport = null;

function expandPlaceholders(raw) {
  return raw.replace(/\$\{([^}]+)\}/g, (_, name) => process.env[name] ?? "");
}

async function loadServerConfig() {
  const file = await fs.readFile(CONFIG_PATH, "utf-8");
  return JSON.parse(expandPlaceholders(file));
}

function validateEnv(envConfig = {}, serverId) {
  const missing = Object.entries(envConfig)
    .filter(([, value]) => !value)
    .map(([key]) => key);
  if (missing.length) {
    console.warn(
      `[Gateway] Skipping server '${serverId}' because the following environment variables are missing: ${missing.join(
        ", ",
      )}`,
    );
    return null;
  }

  return {
    ...process.env,
    ...envConfig,
  };
}

function registerTool(serverId, client, tool) {
  const qualifiedName = `${serverId}_${tool.name}`;

  if (registeredTools.has(qualifiedName)) {
    return;
  }

  const inputSchema = tool.inputSchema ?? { type: "object", properties: {} };

  aggregatorServer.tool(
    qualifiedName,
    inputSchema,
    async (args) => {
      const payload = args ?? {};
      const result = await client.callTool({
        name: tool.name,
        arguments: payload,
      });
      return result;
    },
  );

  registeredTools.add(qualifiedName);
  const meta = activeClients.get(serverId);
  if (meta) {
    meta.tools ??= new Set();
    meta.tools.add(qualifiedName);
  }

  console.log(`[Gateway] Registered tool '${qualifiedName}' from ${serverId}`);
}

async function connectServer(serverId, spec) {
  if (!spec?.command) {
    console.warn(`[Gateway] Missing command for server '${serverId}'. Skipping.`);
    return;
  }

  const env = validateEnv(spec.env, serverId);
  if (!env) {
    return;
  }

  const command = Array.isArray(spec.command) ? spec.command[0] : spec.command;
  const inlineArgs = Array.isArray(spec.command) ? spec.command.slice(1) : [];
  const args = Array.isArray(spec.args) ? spec.args : inlineArgs;

  if (!command) {
    console.warn(`[Gateway] Invalid command for '${serverId}'. Skipping.`);
    return;
  }

  try {
    const transport = new StdioClientTransport({
      command,
      args,
      env,
    });
    const client = new Client({ name: `${SERVER_NAME}-client`, version: SERVER_VERSION }, { capabilities: {} });
    await client.connect(transport);

    activeClients.set(serverId, {
      client,
      transport,
      tools: new Set(),
    });

    const { tools } = await client.listTools();
    tools.forEach((tool) => registerTool(serverId, client, tool));

    console.log(`[Gateway] Connected to ${serverId} (${tools.length} tools).`);
  } catch (error) {
    console.error(`[Gateway] Failed to start server '${serverId}':`, error);
  }
}

async function connectAllServers() {
  const config = await loadServerConfig();
  const entries = Object.entries(config);

  if (!entries.length) {
    console.warn("[Gateway] No MCP servers configured. Update servers_config.json to add providers.");
  }

  await Promise.all(entries.map(([serverId, spec]) => connectServer(serverId, spec)));
}

function createHttpServer() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors());

  app.get("/healthz", (req, res) => {
    res.json({
      ok: true,
      servers: Array.from(activeClients.entries()).map(([serverId, meta]) => ({
        id: serverId,
        tools: meta.tools ? Array.from(meta.tools) : [],
      })),
    });
  });

  app.get(SSE_PATH, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "text/event-stream");

    if (activeTransport) {
      console.warn("[Gateway] Existing SSE client detected; replacing active transport.");
      activeTransport = null;
    }

    const transport = new SSEServerTransport(MESSAGES_PATH, res);
    activeTransport = transport;

    req.on("close", () => {
      if (activeTransport === transport) {
        activeTransport = null;
      }
    });

    try {
      await aggregatorServer.connect(transport);
    } catch (error) {
      console.error("[Gateway] Failed to establish SSE connection:", error);
      res.status(500).end();
    }
  });

  app.post(MESSAGES_PATH, async (req, res) => {
    if (!activeTransport) {
      res.status(503).json({ error: "No active SSE session." });
      return;
    }

    try {
      await activeTransport.handlePostMessage(req, res);
    } catch (error) {
      console.error("[Gateway] Error while forwarding message:", error);
      res.status(500).json({ error: "Failed to forward message." });
    }
  });

  app.listen(PORT, () => {
    console.log(`[Gateway] Listening on port ${PORT}. SSE endpoint: http://0.0.0.0:${PORT}${SSE_PATH}`);
  });
}

await connectAllServers();
createHttpServer();
