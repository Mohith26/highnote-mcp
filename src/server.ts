import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { HighnoteClient } from "./client.js";
import type { Config } from "./config.js";
import { registerTools } from "./tools.js";

export { loadConfig } from "./config.js";
export type { Config } from "./config.js";
export type { HighnoteClient } from "./client.js";

export const SERVER_NAME = "highnote-mcp";
export const SERVER_VERSION = "0.1.0";

export function createServer(client: HighnoteClient, config: Config): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        `Highnote card issuing tools (${config.environment} environment). ` +
        "Give each agent or workflow its own virtual card, put a per-transaction limit and merchant category rule on it, " +
        "and close it when the work is done." +
        (config.environment === "live" ? " Live changes only happen when a tool is called with confirm: true." : ""),
    },
  );
  registerTools(server, client, config);
  return server;
}
