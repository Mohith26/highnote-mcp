#!/usr/bin/env node
import { Highnote } from "@highnote-oss/nodejs-sdk";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { createServer, loadConfig } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const client = new Highnote({
    apiKey: config.apiKey,
    environment: config.environment,
    ...(process.env.HIGHNOTE_BASE_URL ? { baseUrl: process.env.HIGHNOTE_BASE_URL } : {}),
  });
  const server = createServer(client, config);
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
