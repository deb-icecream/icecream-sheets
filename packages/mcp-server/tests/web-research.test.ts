/**
 * Web research tools (Task A): search_web / fetch_web_page over the MCP
 * protocol. Fail closed without a provider (never ambient fetch),
 * enforce HTTPS + bounds, and pass queries through to the provider.
 */
import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer, type ServerOptions } from '../src/server.js';

interface ToolTextContent {
  type: 'text';
  text: string;
}

function payloadOf(result: unknown): Record<string, unknown> {
  const res = result as { content: ToolTextContent[]; isError?: boolean };
  expect(res.content).toHaveLength(1);
  return JSON.parse(res.content[0]?.text ?? '{}') as Record<string, unknown>;
}

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

async function makeClient(options?: ServerOptions): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer(undefined, options);
  await server.connect(serverTransport);
  const client = new Client({ name: 'web-research-test-client', version: '0.0.0' });
  await client.connect(clientTransport);
  return client;
}

const stubProvider = (seen: { search: unknown[]; fetch: unknown[] }) => ({
  name: 'stub',
  search: async (req: { query: string; maxResults?: number }) => {
    seen.search.push(req);
    return { results: [{ title: 'Census', url: 'https://www.census.gov/x', snippet: 'pop' }], provider: 'stub' };
  },
  fetchPage: async (req: { url: string; maxChars?: number }) => {
    seen.fetch.push(req);
    return { url: req.url, finalUrl: req.url, status: 200, contentType: 'text/html', text: 'hello', truncated: false };
  },
});

describe('web research tools without a provider (fail closed)', () => {
  it('search_web fails closed with a config message, never fetches', async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: 'search_web',
      arguments: { principal: 'user:test', query: 'US population' },
    });
    expect(isError(res)).toBe(true);
    expect(JSON.stringify(payloadOf(res))).toMatch(/not configured/i);
  });

  it('fetch_web_page fails closed with a config message, never fetches', async () => {
    const client = await makeClient();
    const res = await client.callTool({
      name: 'fetch_web_page',
      arguments: { principal: 'user:test', url: 'https://www.census.gov/x' },
    });
    expect(isError(res)).toBe(true);
    expect(JSON.stringify(payloadOf(res))).toMatch(/not configured/i);
  });
});

describe('web research tools with a provider', () => {
  it('search_web passes the bounded query through and returns results', async () => {
    const seen = { search: [] as unknown[], fetch: [] as unknown[] };
    const client = await makeClient({ webResearch: { provider: stubProvider(seen) } });
    const res = await client.callTool({
      name: 'search_web',
      arguments: { principal: 'user:test', query: 'US population 1900', maxResults: 3 },
    });
    expect(isError(res)).toBe(false);
    expect(seen.search).toEqual([{ query: 'US population 1900', maxResults: 3 }]);
    const payload = payloadOf(res) as { results: { url: string }[] };
    expect(payload.results[0].url).toBe('https://www.census.gov/x');
  });

  it('fetch_web_page rejects non-HTTPS and private hosts before the provider', async () => {
    const seen = { search: [] as unknown[], fetch: [] as unknown[] };
    const client = await makeClient({ webResearch: { provider: stubProvider(seen) } });
    for (const url of ['http://example.com/x', 'https://localhost:8100/api', 'https://192.168.1.5/x']) {
      const res = await client.callTool({ name: 'fetch_web_page', arguments: { principal: 'user:test', url } });
      expect(isError(res)).toBe(true);
    }
    expect(seen.fetch).toEqual([]);
  });

  it('fetch_web_page passes HTTPS public URLs with bounded maxChars', async () => {
    const seen = { search: [] as unknown[], fetch: [] as unknown[] };
    const client = await makeClient({ webResearch: { provider: stubProvider(seen) } });
    const res = await client.callTool({
      name: 'fetch_web_page',
      arguments: { principal: 'user:test', url: 'https://www.census.gov/x', maxChars: 1000 },
    });
    expect(isError(res)).toBe(false);
    expect(seen.fetch).toEqual([{ url: 'https://www.census.gov/x', maxChars: 1000 }]);
  });
});
