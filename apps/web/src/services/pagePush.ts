import { getFirestore } from 'firebase/firestore';

import { app, auth } from '@/config/firebase';

import { base64 } from './e2ee';
import { iconOf } from './pageIcon';
import { planApi } from './plan';
import { UNCONFIRMED_MESSAGE, isRulesRefusal, refusalMessage } from './pushRefusal';
import { PushTooLongError, PushUnconfirmedError, createUrlPush, keyIsStale, loadPushKeys } from './pushes';

/**
 * Pushing from the Chrome extension itself: the popup's button, the keyboard shortcut and
 * the right-click menu (docs/web.md, Pushing from the extension). Shared by the popup page
 * and the service worker, so it uses nothing either lacks: no DOM, no React, and a canvas
 * only as `OffscreenCanvas`.
 *
 * The point of pushing from here rather than the site's Push page is that Chrome already
 * holds the page: the tab's title, and the tab's icon in Chrome's own icon store. A push
 * made with both is complete when it lands, where one from the site waits for a phone or a
 * Mac to scrape the page (docs/e2ee.md, Titles and Icons), which never happens for someone
 * who has no phone app, or whose phone missed the notification.
 */

/** What a push from the extension carries. `title` may be empty, `icon` absent. */
export interface Page {
  url: string;
  title: string;
  icon?: string;
}

/** A push that could not be made, said in a sentence for the person who asked for it. */
export class PagePushError extends Error {
  /** Whether signing in on the extension's page is what would fix it. */
  readonly needsSignIn: boolean;
  constructor(message: string, needsSignIn = false) {
    super(message);
    this.needsSignIn = needsSignIn;
  }
}

export const SIGNED_OUT_MESSAGE = 'Sign in to PushThat to push from this browser.';
// The account key is stored per browser at sign-in, so a session without it (one from
// before encryption, or a browser that refused IndexedDB) cannot seal a push.
const NO_KEYS_MESSAGE = 'Your encryption key is not on this browser. Open PushThat and sign in again.';
export const NOT_A_WEB_PAGE_MESSAGE = 'Only web pages can be pushed.';

/**
 * Whether `url` is worth pushing: a web page another device can open. Not `chrome://`,
 * `file://`, the extension's own pages or the like, which mean nothing anywhere else.
 */
export const isWebPage = (url: string | undefined): url is string => {
  if (!url) return false;
  try {
    const { protocol } = new URL(url);
    return protocol === 'https:' || protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * The page a tab shows, ready to push, or undefined when it is not a web page. The title is
 * Chrome's, which is the page's `<title>`; for a page without one Chrome shows its URL, and
 * that is not a title, so the push goes without one and a phone may still find one.
 */
export async function pageOfTab(tab: chrome.tabs.Tab): Promise<Page | undefined> {
  const url = tab.url;
  if (!isWebPage(url)) return undefined;
  const raw = tab.title?.trim() ?? '';
  const title = raw === url || raw === url.replace(/^https?:\/\//, '') ? '' : raw;
  // `favIconUrl` is empty while the page has no icon of its own, and Chrome's icon store
  // would answer then with its generic globe, which is worse than no icon: the list's own
  // placeholder says "no icon", the globe says this site's icon is a globe.
  const icon = tab.favIconUrl ? await storedIcon(url).catch(() => undefined) : undefined;
  return { url, title, icon };
}

/**
 * The icon Chrome keeps for `pageUrl`, as the envelope carries it: a PNG within 64 by 64 and
 * 4096 bytes (docs/e2ee.md, Icons). Read from `_favicon`, the extension's view of Chrome's
 * own icon store (the `favicon` permission), so nothing goes over the network: not to the
 * site, which a fetch of `favIconUrl` would tell, and not to Google, which drew these until
 * the icon moved into the push. It also needs no host permission and meets no CORS, which
 * a fetch of the site's icon would for every site.
 *
 * Scaled down to fit 64 by 64 and never up, and when that is over 4096 bytes, to 32 by 32
 * once more, then none: the same steps the phones take. Chrome hands back its own raster,
 * so an SVG icon, which the phones pass over, arrives here as pixels like any other.
 */
async function storedIcon(pageUrl: string): Promise<string | undefined> {
  const address = new URL(chrome.runtime.getURL('/_favicon/'));
  address.searchParams.set('pageUrl', pageUrl);
  address.searchParams.set('size', '64');
  const response = await fetch(address);
  if (!response.ok) return undefined;
  const bitmap = await createImageBitmap(await response.blob());
  try {
    return (await pngWithin(bitmap, 64)) ?? (await pngWithin(bitmap, 32));
  } finally {
    bitmap.close();
  }
}

/** `bitmap` as base64 PNG fitting `side` by `side`, or undefined when `iconOf` would refuse it. */
async function pngWithin(bitmap: ImageBitmap, side: number): Promise<string | undefined> {
  const scale = Math.min(1, side / bitmap.width, side / bitmap.height);
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.drawImage(bitmap, 0, 0, width, height);
  const png = await canvas.convertToBlob({ type: 'image/png' });
  // `iconOf` is the test every client draws by, so a push from here is never one the lists
  // would pass over.
  return iconOf(base64(new Uint8Array(await png.arrayBuffer())));
}

/**
 * Pushes `page` for whoever is signed in to the extension. Throws a `PagePushError` whose
 * message is the sentence to show: the reasons are the Push page's, read the same way
 * (pushRefusal.ts), without the plan check before sending, which would be a round trip on
 * every push to save one on the rare refused one.
 */
export async function pushPage(page: Page): Promise<void> {
  await auth.authStateReady();
  const uid = auth.currentUser?.uid;
  if (!uid) throw new PagePushError(SIGNED_OUT_MESSAGE, true);
  const db = getFirestore(app);
  const keys = await loadPushKeys(db, uid);
  if (!keys) throw new PagePushError(NO_KEYS_MESSAGE, true);
  try {
    await createUrlPush(db, keys, page.url, page.title, page.icon);
  } catch (error) {
    if (isRulesRefusal(error)) {
      throw new PagePushError(
        await refusalMessage(
          undefined,
          'url',
          () => planApi.getPlan(),
          () => keyIsStale(db, keys)
        )
      );
    }
    if (error instanceof PushUnconfirmedError) throw new PagePushError(UNCONFIRMED_MESSAGE);
    if (error instanceof PushTooLongError) throw new PagePushError('That link is too long to push.');
    console.error('Could not push a page:', error);
    throw new PagePushError('Could not push this page. Check your connection and try again.');
  }
}
