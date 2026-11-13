// A URL push's page icon as the list may draw it (docs/e2ee.md, Icons). Apart from
// `pushes.ts`, which needs Firebase, so that `npm run test:keys` checks it in plain Node.

/**
 * What the list draws for a push with no icon of its own, and for a locked one; the popup
 * draws it for a page it has no icon for. In one place so the two cannot drift.
 */
export const PLACEHOLDER_ICON = '/pushthat-mono.svg';

// 4096 bytes of PNG, at most 64 pixels a side (docs/e2ee.md, Icons).
const MAX_ICON_BYTES = 4096;
const MAX_ICON_SIDE = 64;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/**
 * The envelope's icon, if it is one the list can show. It ends up in a `data:` URL, so it
 * must be base64 and nothing else: a string that is not cannot smuggle anything into the
 * `src`. It must also be what every client draws and nothing else, a PNG within 64 by 64,
 * read from its header before the browser decodes it, so an icon some other writer got
 * wrong is passed over here as it is on the phones. A PNG that passes and still
 * will not decode is the `img`'s `onError`.
 */
export const iconOf = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length % 4 !== 0 || !BASE64.test(value)) return undefined;
  // Counted in bytes, as the phones count it: 5464 characters without padding hold 4098.
  const padding = value.endsWith('==') ? 2 : value.endsWith('=') ? 1 : 0;
  if ((value.length / 4) * 3 - padding > MAX_ICON_BYTES) return undefined;
  // The signature, then IHDR's length and type, then its width and height: 24 bytes, which
  // are the first 32 characters of the base64.
  const header = Uint8Array.from(atob(value.slice(0, 32)), (c) => c.charCodeAt(0));
  if (header.length < 24 || PNG_SIGNATURE.some((byte, i) => header[i] !== byte)) return undefined;
  const view = new DataView(header.buffer);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  return width >= 1 && width <= MAX_ICON_SIDE && height >= 1 && height <= MAX_ICON_SIDE ? value : undefined;
};
