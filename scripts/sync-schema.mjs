// Refreshes tests/fixtures/highnote-schema.graphql from the Highnote Node SDK's published schema snapshot.
import { writeFile } from "node:fs/promises";

const ref = process.argv[2] ?? "main";
const url = `https://raw.githubusercontent.com/highnote-oss/nodejs-sdk/${ref}/schema.graphql`;
const response = await fetch(url);
if (!response.ok) throw new Error(`GET ${url} -> ${response.status}`);
const schema = await response.text();
const header =
  `# Highnote GraphQL schema snapshot from https://github.com/highnote-oss/nodejs-sdk/blob/${ref}/schema.graphql (MIT).\n` +
  "# Refresh with: npm run schema:sync\n";
await writeFile(new URL("../tests/fixtures/highnote-schema.graphql", import.meta.url), header + schema);
console.log(`Wrote ${schema.split("\n").length} lines from ${url}`);
