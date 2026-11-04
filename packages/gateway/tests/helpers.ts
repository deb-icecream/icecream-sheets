/** Shared test helpers: ephemeral servers + JSON HTTP client. */
import http, { type RequestListener } from 'node:http';

export interface Started {
  server: http.Server;
  port: number;
  url: string;
}

export async function startServer(listener: RequestListener): Promise<Started> {
  const server = http.createServer(listener);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  if (typeof addr !== 'object' || addr === null) throw new Error('no address');
  const port = addr.port;
  return { server, port, url: `http://127.0.0.1:${port}` };
}

export async function stop(s: Started): Promise<void> {
  await new Promise<void>((resolve) => s.server.close(() => resolve()));
}

export interface HttpResult {
  status: number;
  headers: http.IncomingHttpHeaders;
  json: unknown;
  text: string;
}

export async function httpJson(
  method: string,
  url: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResult> {
  const bodyText = opts.body === undefined ? undefined : JSON.stringify(opts.body);
  const res = await fetch(url, {
    method,
    headers: {
      ...(bodyText !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(opts.headers ?? {}),
    },
    body: bodyText,
  });
  const text = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(text);
  } catch {
    // leave null
  }
  const headers: http.IncomingHttpHeaders = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, headers, json, text };
}

/** A mock backend that records requests and echoes them back as JSON. */
export interface EchoBackend extends Started {
  last: {
    method: string;
    url: string;
    headers: Record<string, string | string[] | undefined>;
    body: string;
  } | null;
}

export async function startEchoBackend(status = 200): Promise<EchoBackend> {
  const backend = (await startServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => {
      body += c.toString();
    });
    req.on('end', () => {
      const headers: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) headers[k] = v;
      (backend as EchoBackend).last = {
        method: req.method ?? '',
        url: req.url ?? '',
        headers,
        body,
      };
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, echoed: (backend as EchoBackend).last }));
    });
  })) as EchoBackend;
  backend.last = null;
  return backend;
}
