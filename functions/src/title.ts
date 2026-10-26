import { HttpsError } from 'firebase-functions/v2/https';

/**
 * The page title the web app asks for before it pushes a URL (`getPageTitle` in
 * index.ts), since a browser cannot read a cross-origin page. The native apps scrape
 * their own titles on the device and never call this.
 *
 * The function fetches a URL the caller names, from inside the project, which makes it
 * a fetch oracle for whoever can call it: so it answers only a signed-in account (the
 * callable checks), only `http` and `https` (not `file:` or anything else Node's fetch
 * might one day grow), gives up after `TITLE_FETCH_TIMEOUT_MS`, and reads no more than
 * `TITLE_FETCH_MAX_BYTES` of the body. The title is in the head, so a page cut short
 * still gives it, and a page that streams without end cannot hold the function or its
 * memory. The URL is not logged: what someone pushes is theirs (AGENTS.md).
 */

export const TITLE_FETCH_TIMEOUT_MS = 10_000;
export const TITLE_FETCH_MAX_BYTES = 512 * 1024;

/** The text of a page's `<title>`, trimmed, or '' when it has none. */
export function titleIn(html: string): string {
  const match = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  return match ? match[1].trim() : '';
}

/** Reads at most `maxBytes` of the body as text, then stops reading. */
async function readUpTo(resp: Response, maxBytes: number): Promise<string> {
  if (!resp.body) return '';
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let read = 0;
  while (read < maxBytes) {
    const { value, done } = await reader.read();
    if (done) break;
    read += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  if (read >= maxBytes) await reader.cancel();
  return text;
}

export async function pageTitleOf(
  url: unknown,
  {
    timeoutMs = TITLE_FETCH_TIMEOUT_MS,
    maxBytes = TITLE_FETCH_MAX_BYTES,
    fetchImpl = fetch,
  }: { timeoutMs?: number; maxBytes?: number; fetchImpl?: typeof fetch } = {}
): Promise<string> {
  if (typeof url !== 'string' || !url) throw new HttpsError('invalid-argument', 'URL is required');
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new HttpsError('invalid-argument', 'Not a URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new HttpsError('invalid-argument', 'Only http and https pages have titles');
  }

  let resp: Response;
  try {
    resp = await fetchImpl(parsed.href, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    if ((err as { name?: string }).name === 'TimeoutError') {
      throw new HttpsError('deadline-exceeded', 'The page took too long to answer');
    }
    throw new HttpsError('unavailable', 'The page could not be fetched');
  }
  if (resp.status !== 200) {
    await resp.body?.cancel();
    throw new HttpsError('internal', `Failed to fetch page with status code: ${resp.status}`);
  }
  if (!resp.headers.get('content-type')?.includes('text/html')) {
    await resp.body?.cancel();
    throw new HttpsError('internal', 'The page is not HTML');
  }
  return titleIn(await readUpTo(resp, maxBytes));
}
