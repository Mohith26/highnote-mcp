import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import type { Config, HighnoteClient } from "../src/server.js";
import { createServer } from "../src/server.js";

export const baseConfig: Config = {
  apiKey: "sk_test_x",
  environment: "test",
  readOnly: false,
  maxTransactionLimit: 50_000,
  maxCardLifetimeDays: 365,
  currency: "USD",
};

/** Starts the server on an in-memory transport and returns a connected MCP client. */
export async function connect(client: HighnoteClient, config: Partial<Config> = {}) {
  const server = createServer(client, { ...baseConfig, ...config });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([server.connect(serverTransport), mcp.connect(clientTransport)]);

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = (await mcp.callTool({ name, arguments: args })) as CallToolResult;
    const text = result.content.map((c) => (c.type === "text" ? c.text : "")).join("");
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
    return { isError: result.isError === true, text, data: data as any };
  }

  return { mcp, call, close: () => mcp.close() };
}
