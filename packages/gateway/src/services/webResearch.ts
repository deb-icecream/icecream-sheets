/**
 * Web research providers — service-boundary only.
 * Tavily primary, Brave fallback. Keys stay server-side (process env);
 * never read from browser localStorage / import.meta.env. No
 * browser-side research.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import {
  boundedSearchResultCount,
  boundedWebPageChars,
  normalizePublicWebUrl,
  isObviouslyPrivateHost,
  normalizeWebSearchResults,
  cleanWebText,
  type WebSearchRequest,
  type WebSearchResponse,
  type WebPageFetchRequest,
  type WebPageFetchResponse,
  type WebResearchProvider,
} from '@icecream-sheets/service';

export interface SafeWebFetcherOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export type SafeWebFetcher = (
  url: string,
  opts?: SafeWebFetcherOptions,
) => Promise<{
  status: number;
  headers: Record<string, string>;
  body: string;
  finalUrl: string;
}>;

function isPrivateIPLiteral(ip: string): boolean {
  const v = ip.trim().toLowerCase();
  if (!v) return true;
  // Strip IPv6 brackets.
  const bare = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
  if (bare === 'localhost' || bare === '::1') return true;
  if (bare.includes(':')) {
    // IPv6: loopback, unspecified, link-local, unique-local, documentation.
    if (bare === '::' || bare === '::1') return true;
    const lower = bare.split('%')[0] ?? bare;
    if (lower.startsWith('fe80:') || lower.startsWith('fec0:')) return true;
    if (lower.startsWith('fc') || lower.startsWith('fd')) return true;
    if (lower.startsWith('2001:db8')) return true;
    if (lower.startsWith('::ffff:')) {
      const v4 = lower.slice('::ffff:'.length);
      return isPrivateIPLiteral(v4);
    }
    return false;
  }
  const parts = bare.split('.');
  if (parts.length !== 4) return false;
  const nums = parts.map((p) => Number(p));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a = 0, b = 0] = nums;
  if (a === 10) return true;
  if (a === 172 && (b as number) >= 16 && (b as number) <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a >= 224) return true;
  return false;
}

async function assertHostResolvesPublic(hostname: string): Promise<void> {
  if (isObviouslyPrivateHost(hostname)) {
    throw new Error(`URL host is private or blocked: ${hostname}`);
  }
  // Literal IPs are already classified above; only DNS-resolvable names reach lookup.
  if (isPrivateIPLiteral(hostname)) {
    throw new Error(`URL host is private or blocked: ${hostname}`);
  }
  let addresses: { address: string }[];
  try {
    addresses = await dnsLookup(hostname, { all: true });
  } catch {
    throw new Error(`URL host does not resolve to a public address: ${hostname}`);
  }
  if (addresses.length === 0) {
    throw new Error(`URL host does not resolve to a public address: ${hostname}`);
  }
  for (const entry of addresses) {
    if (isPrivateIPLiteral(entry.address)) {
      throw new Error(`URL host resolves to a private address: ${hostname}`);
    }
  }
}

export function createSafeWebFetcher(opts: SafeWebFetcherOptions = {}): SafeWebFetcher {
  const defaultTimeout = opts.timeoutMs ?? 10000;
  const defaultMaxBytes = opts.maxBytes ?? 2 * 1024 * 1024; // 2MB
  const defaultMaxRedirects = opts.maxRedirects ?? 3;
  return async (rawUrl: string, fetchOpts: SafeWebFetcherOptions = {}) => {
    const timeoutMs = fetchOpts.timeoutMs ?? defaultTimeout;
    const maxBytes = fetchOpts.maxBytes ?? defaultMaxBytes;
    const maxRedirects = fetchOpts.maxRedirects ?? defaultMaxRedirects;
    let currentUrl = rawUrl;
    // Validate initial URL (HTTPS, no credentials, no private host).
    currentUrl = normalizePublicWebUrl(currentUrl);
    await assertHostResolvesPublic(new URL(currentUrl).hostname);
    let lastStatus = 0;
    let lastHeaders: Record<string, string> = {};
    let lastBody = '';
    let finalUrl = currentUrl;
    for (let redirect = 0; redirect <= maxRedirects; redirect++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const res = await fetch(currentUrl, {
          method: 'GET',
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            'User-Agent': 'icecream-sheets-web-research/1.0',
            Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          },
          // No cookies/credentials
          credentials: 'omit',
        });
        lastStatus = res.status;
        lastHeaders = {};
        res.headers.forEach((v: string, k: string) => {
          lastHeaders[k.toLowerCase()] = v;
        });
        // Handle redirects with revalidation
        if (res.status >= 300 && res.status < 400) {
          const location = res.headers.get('location');
          if (!location) {
            lastBody = '';
            finalUrl = currentUrl;
            break;
          }
          let nextUrl: string;
          try {
            nextUrl = new URL(location, currentUrl).toString();
          } catch {
            throw new Error(`invalid redirect location: ${location}`);
          }
          // Revalidate redirect target (HTTPS + DNS/IP per hop).
          nextUrl = normalizePublicWebUrl(nextUrl);
          await assertHostResolvesPublic(new URL(nextUrl).hostname);
          currentUrl = nextUrl;
          finalUrl = nextUrl;
          continue;
        }
        // Read body with byte bound
        const buf = await res.arrayBuffer();
        const bytes = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
        lastBody = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
        finalUrl = currentUrl;
        break;
      } catch (e) {
        clearTimeout(timer);
        if (e instanceof Error && e.name === 'AbortError') {
          throw new Error(`fetch timeout after ${timeoutMs}ms: ${currentUrl}`);
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    }
    return { status: lastStatus, headers: lastHeaders, body: lastBody, finalUrl };
  };
}

// --- Tavily provider --------------------------------------------------------

export class TavilyWebResearchProvider implements WebResearchProvider {
  private apiKey: string;
  name = 'tavily';
  private fetcher: SafeWebFetcher;
  constructor(apiKey: string, fetcher?: SafeWebFetcher) {
    this.apiKey = apiKey;
    this.fetcher = fetcher ?? createSafeWebFetcher();
  }
  async search(req: WebSearchRequest): Promise<WebSearchResponse> {
    const maxResults = boundedSearchResultCount(req.maxResults);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          api_key: this.apiKey,
          query: req.query,
          max_results: maxResults,
          search_depth: 'basic',
          include_answer: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Tavily search failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as { results?: unknown };
      const rawResults = Array.isArray(json.results) ? json.results : [];
      const mapped = rawResults.map((r) => {
        const rec = r as Record<string, unknown>;
        return {
          title: typeof rec.title === 'string' ? rec.title : '',
          url: typeof rec.url === 'string' ? rec.url : '',
          snippet:
            typeof rec.content === 'string'
              ? rec.content
              : typeof rec.snippet === 'string'
                ? rec.snippet
                : '',
          score: typeof rec.score === 'number' ? rec.score : undefined,
        };
      });
      const results = normalizeWebSearchResults(mapped).slice(0, maxResults);
      return { results, provider: this.name };
    } finally {
      clearTimeout(timer);
    }
  }
  async fetchPage(req: WebPageFetchRequest): Promise<WebPageFetchResponse> {
    const url = normalizePublicWebUrl(req.url);
    const maxChars = boundedWebPageChars(req.maxChars);
    const res = await this.fetcher(url);
    const contentType = res.headers['content-type'] ?? '';
    let text = cleanWebText(res.body);
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    return {
      url: req.url,
      finalUrl: res.finalUrl,
      status: res.status,
      contentType,
      text,
      truncated,
    };
  }
}

// --- Brave provider (fallback only) -----------------------------------------

export class BraveWebResearchProvider implements WebResearchProvider {
  private apiKey: string;
  name = 'brave';
  private fetcher: SafeWebFetcher;
  constructor(apiKey: string, fetcher?: SafeWebFetcher) {
    this.apiKey = apiKey;
    this.fetcher = fetcher ?? createSafeWebFetcher();
  }
  async search(req: WebSearchRequest): Promise<WebSearchResponse> {
    const maxResults = boundedSearchResultCount(req.maxResults);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(req.query)}&count=${maxResults}`;
      const res = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.apiKey,
        },
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Brave search failed: ${res.status} ${text.slice(0, 200)}`);
      }
      const json = (await res.json()) as { web?: { results?: unknown } };
      const rawResults = Array.isArray(json.web?.results) ? (json.web?.results as unknown[]) : [];
      const mapped = rawResults.map((r) => {
        const rec = r as Record<string, unknown>;
        return {
          title: typeof rec.title === 'string' ? rec.title : '',
          url: typeof rec.url === 'string' ? rec.url : '',
          snippet:
            typeof rec.description === 'string'
              ? rec.description
              : typeof rec.snippet === 'string'
                ? rec.snippet
                : '',
        };
      });
      const results = normalizeWebSearchResults(mapped).slice(0, maxResults);
      return { results, provider: this.name };
    } finally {
      clearTimeout(timer);
    }
  }
  async fetchPage(req: WebPageFetchRequest): Promise<WebPageFetchResponse> {
    const url = normalizePublicWebUrl(req.url);
    const maxChars = boundedWebPageChars(req.maxChars);
    const res = await this.fetcher(url);
    const contentType = res.headers['content-type'] ?? '';
    let text = cleanWebText(res.body);
    let truncated = false;
    if (text.length > maxChars) {
      text = text.slice(0, maxChars);
      truncated = true;
    }
    return {
      url: req.url,
      finalUrl: res.finalUrl,
      status: res.status,
      contentType,
      text,
      truncated,
    };
  }
}

// --- Factory ----------------------------------------------------------------

export function getWebResearchProvider(): WebResearchProvider | null {
  const tavilyKey = (process.env.TAVILY_API_KEY ?? '').trim();
  if (tavilyKey) {
    return new TavilyWebResearchProvider(tavilyKey, createSafeWebFetcher());
  }
  const braveKey = (process.env.BRAVE_SEARCH_API_KEY ?? '').trim();
  if (braveKey) {
    return new BraveWebResearchProvider(braveKey, createSafeWebFetcher());
  }
  return null;
}
