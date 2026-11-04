/**
 * Web research contracts — service-boundary only.
 * Engine must keep no ambient network/filesystem/clock.
 */

export const WEB_RESEARCH_PROTOCOL_VERSION = 1;
export const DEFAULT_WEB_SEARCH_MAX_RESULTS = 8;
export const MAX_WEB_SEARCH_MAX_RESULTS = 10;
export const DEFAULT_WEB_PAGE_MAX_CHARS = 24000;
export const MAX_WEB_PAGE_MAX_CHARS = 48000;

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  score?: number;
}

export interface WebSearchRequest {
  query: string;
  maxResults?: number;
}

export interface WebSearchResponse {
  results: WebSearchResult[];
  provider: string;
}

export interface WebPageFetchRequest {
  url: string;
  maxChars?: number;
}

export interface WebPageFetchResponse {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

export interface WebResearchProvider {
  name: string;
  search(req: WebSearchRequest): Promise<WebSearchResponse>;
  fetchPage(req: WebPageFetchRequest): Promise<WebPageFetchResponse>;
}

function isIPv4Private(host: string): boolean {
  // Check obvious private patterns
  if (host === 'localhost' || host === '127.0.0.1' || host === '0.0.0.0') return true;
  if (host.startsWith('10.')) return true;
  if (host.startsWith('192.168.')) return true;
  if (host.startsWith('172.')) {
    const second = parseInt(host.split('.')[1] ?? '', 10);
    if (second >= 16 && second <= 31) return true;
  }
  if (host.startsWith('169.254.')) return true;
  if (host === '::1' || host === '[::1]') return true;
  return false;
}

export function isObviouslyPrivateHost(host: string): boolean {
  const h = host.toLowerCase().trim();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' || h === '[::1]') return true;
  if (h.startsWith('10.')) return true;
  if (h.startsWith('192.168.')) return true;
  if (h.startsWith('169.254.')) return true;
  if (h.startsWith('172.')) {
    const parts = h.split('.');
    if (parts.length >= 2) {
      const n = parseInt(parts[1]!, 10);
      if (!Number.isNaN(n) && n >= 16 && n <= 31) return true;
    }
  }
  // Single label (no dot) except known public TLDs is private
  if (!h.includes('.') && h !== 'localhost') {
    // Be conservative: single label is considered private
    return true;
  }
  if (h.endsWith('.internal') || h.endsWith('.local')) return true;
  // Check raw IP private
  if (isIPv4Private(h)) return true;
  return false;
}

export function normalizePublicWebUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`invalid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`URL must use HTTPS: ${raw}`);
  }
  if (url.username || url.password) {
    throw new Error(`URL must not contain credentials: ${raw}`);
  }
  if (isObviouslyPrivateHost(url.hostname)) {
    throw new Error(`URL host is private or blocked: ${url.hostname}`);
  }
  // Normalize: remove fragment, preserve search
  url.hash = '';
  return url.toString();
}

export function boundedSearchResultCount(n: number | undefined): number {
  if (n === undefined || n === null) return DEFAULT_WEB_SEARCH_MAX_RESULTS;
  const v = Math.floor(n);
  if (!Number.isFinite(v) || v < 1) return 1;
  if (v > MAX_WEB_SEARCH_MAX_RESULTS) return MAX_WEB_SEARCH_MAX_RESULTS;
  return v;
}

export function boundedWebPageChars(n: number | undefined): number {
  if (n === undefined || n === null) return DEFAULT_WEB_PAGE_MAX_CHARS;
  const v = Math.floor(n);
  if (!Number.isFinite(v) || v < 1) return 1;
  if (v > MAX_WEB_PAGE_MAX_CHARS) return MAX_WEB_PAGE_MAX_CHARS;
  return v;
}

export function normalizeWebSearchResults(results: unknown[]): WebSearchResult[] {
  const out: WebSearchResult[] = [];
  for (const r of results) {
    if (typeof r !== 'object' || r === null) continue;
    const rec = r as Record<string, unknown>;
    const title = typeof rec.title === 'string' ? rec.title.trim().slice(0, 300) : '';
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    const snippet =
      typeof rec.snippet === 'string'
        ? rec.snippet.trim().slice(0, 2000)
        : typeof rec.description === 'string'
          ? rec.description.trim().slice(0, 2000)
          : '';
    if (!title || !url) continue;
    try {
      normalizePublicWebUrl(url);
    } catch {
      continue;
    }
    out.push({
      title,
      url,
      snippet,
      ...(typeof rec.score === 'number' && Number.isFinite(rec.score) ? { score: rec.score } : {}),
    });
  }
  return out;
}

export function cleanText(text: string): string {
  // Remove excessive whitespace, control chars
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\x00/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function cleanWebText(html: string): string {
  // Strip HTML tags, decode basics, collapse whitespace
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => {
      const code = parseInt(n, 10);
      if (code >= 32 && code <= 0xffff) return String.fromCharCode(code);
      return '';
    });
  return cleanText(text);
}
