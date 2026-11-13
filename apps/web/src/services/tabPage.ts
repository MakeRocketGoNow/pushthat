// What a Chrome tab gives a push from the extension, before anything is fetched or sealed
// (pagePush.ts). Apart from it, which needs Firebase and the `chrome` APIs, so that
// `npm run test:keys` checks it in plain Node.

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
 * The title to push for a tab showing `url` whose title Chrome gives as `tabTitle`. That is
 * the page's `<title>`; for a page without one Chrome shows its URL instead, and that is not
 * a title, so the push goes without one and a phone may still find one.
 */
export const titleOfTab = (tabTitle: string | undefined, url: string): string => {
  const raw = tabTitle?.trim() ?? '';
  return raw === url || raw === url.replace(/^https?:\/\//, '') ? '' : raw;
};
