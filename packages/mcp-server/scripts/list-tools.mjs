#!/usr/bin/env node
/**
 * List the MCP server's registered tools as a Markdown table.
 *
 * Boots the BUILT server in-process via the library (dist/http.js
 * startMcpHttp on an ephemeral port, requireAuth with a throwaway
 * secret, token minted with @icecream-sheets/service issueToken —
 * the same composition as the MCP validation harness), calls
 * tools/list over the wire, and prints a Markdown table
 * (Tool | What it does) from the registered names + descriptions.
 *
 * Usage (after building): node scripts/list-tools.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { issueToken } from '@icecream-sheets/service';
import { startMcpHttp } from '../dist/http.js';

const secret = 'list-tools-throwaway-secret';

const server = startMcpHttp(0, { requireAuth: true, authSecret: secret }, '127.0.0.1');
if (!server.listening) {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
}
const { port } = server.address();

let client;
let transport;
try {
  const token = await issueToken({ userId: 'list-tools', secret, ttlSeconds: 300 });
  transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  client = new Client({ name: 'list-tools', version: '0.0.0' });
  await client.connect(transport);
  const { tools } = await client.listTools();

  const cell = (s) => String(s ?? '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
  const rows = [...tools].sort((a, b) => a.name.localeCompare(b.name));
  console.log('| Tool | What it does |');
  console.log('|---|---|');
  for (const t of rows) {
    console.log(`| \`${cell(t.name)}\` | ${cell(t.description)} |`);
  }
} finally {
  try {
    await transport?.terminateSession();
  } catch {
    // Session may already be gone; teardown must not fail the listing.
  }
  await client?.close().catch(() => {});
  server.closeAllConnections();
  await new Promise((resolve) => server.close(() => resolve()));
}
