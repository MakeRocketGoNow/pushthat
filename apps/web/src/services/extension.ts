/**
 * Sends `message` to the Chrome extension's service worker when this page is the
 * extension's own bundled page, and does nothing on the site. The same build runs in
 * both, so this is the one place that tells them apart.
 *
 * `chrome.runtime.id` is set only inside an extension. Testing for `chrome` alone was not
 * enough: Chrome defines that global on every page, and a browser that does not define it
 * at all threw a ReferenceError from the auth listener. And a site page that some other
 * extension made reachable has `chrome.runtime.sendMessage` without an id, which would
 * aim the message at that extension.
 */
export function sendToExtension(message: { type: string } & Record<string, unknown>): void {
  if (!isExtensionPage()) return;
  // The worker may be asleep and fail to answer; it reads what it needs again when it
  // starts, so a lost message is logged and not thrown into the page.
  chrome.runtime.sendMessage(message).catch((error) => console.debug('The extension did not take a message:', error));
}

/** Whether this page is the extension's own bundled page rather than the site (see `sendToExtension`). */
export function isExtensionPage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime?.id;
}
