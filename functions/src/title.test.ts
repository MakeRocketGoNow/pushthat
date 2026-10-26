import { HttpsError } from 'firebase-functions/v2/https';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import { pageTitleOf, titleIn } from './title';

/** A stand-in for the page, on a local port: each path answers as the test needs. */
let server: Server;
let origin: string;

const routes = new Map<string, (res: ServerResponse) => void>();
const html = (body: string, res: ServerResponse) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(body);
};

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const route = routes.get(req.url ?? '/');
    if (route) route(res);
    else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

routes.set('/page', (res) => html('<html><head><title> A page </title></head><body></body></html>', res));
routes.set('/untitled', (res) => html('<html><head></head><body>none</body></html>', res));
routes.set('/json', (res) => {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end('{"title":"no"}');
});
routes.set('/slow', (res) => setTimeout(() => html('<title>late</title>', res), 2_000));
// A title at the top, then a body that never ends.
routes.set('/endless', (res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.write('<html><head><title>endless</title></head><body>');
  const chunk = 'x'.repeat(64 * 1024);
  const timer = setInterval(() => res.write(chunk), 1);
  res.on('close', () => clearInterval(timer));
});

const refusal = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(HttpsError);
    return (err as HttpsError).code;
  }
  throw new Error('expected a refusal');
};

describe('the title in a page', () => {
  test('is the title tag, trimmed', () => expect(titleIn('<head><title> Hi </title></head>')).toBe('Hi'));
  test('is empty when there is none', () => expect(titleIn('<p>no</p>')).toBe(''));
  test('whatever the case of the tag', () => expect(titleIn('<TITLE>Up</TITLE>')).toBe('Up'));
});

describe('fetching a page for its title', () => {
  test('gives the title', async () => expect(await pageTitleOf(`${origin}/page`)).toBe('A page'));
  test('gives nothing for a page without one', async () => expect(await pageTitleOf(`${origin}/untitled`)).toBe(''));
  test('refuses what is not HTML', async () => expect(await refusal(pageTitleOf(`${origin}/json`))).toBe('internal'));
  test('refuses a page that is not there', async () =>
    expect(await refusal(pageTitleOf(`${origin}/missing`))).toBe('internal'));
  test('gives up on a page that takes too long', async () =>
    expect(await refusal(pageTitleOf(`${origin}/slow`, { timeoutMs: 200 }))).toBe('deadline-exceeded'));
  test('reads no more of a page than it needs', async () =>
    expect(await pageTitleOf(`${origin}/endless`, { maxBytes: 256 * 1024, timeoutMs: 5_000 })).toBe('endless'));
  test('refuses a URL that is not one, or not a page', async () => {
    expect(await refusal(pageTitleOf(undefined))).toBe('invalid-argument');
    expect(await refusal(pageTitleOf(''))).toBe('invalid-argument');
    expect(await refusal(pageTitleOf('not a url'))).toBe('invalid-argument');
    expect(await refusal(pageTitleOf('file:///etc/hosts'))).toBe('invalid-argument');
    expect(await refusal(pageTitleOf('ftp://example.com/'))).toBe('invalid-argument');
  });
  test('reports a host it cannot reach as unavailable', async () =>
    expect(await refusal(pageTitleOf('http://127.0.0.1:1/', { timeoutMs: 2_000 }))).toBe('unavailable'));
});
