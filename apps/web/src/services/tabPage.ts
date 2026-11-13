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

/** `url` without its scheme or a trailing slash, as Chrome shows a URL in place of a title. */
const bare = (url: string) => url.replace(/^https?:\/\//, '').replace(/\/$/, '');

/** `url` with its escapes decoded, as Chrome shows them, or as it is when they do not decode. */
const decoded = (url: string) => {
  try {
    return decodeURI(url);
  } catch {
    return url;
  }
};

/**
 * The title to push for a tab showing `url` whose title Chrome gives as `tabTitle`. That is
 * the page's `<title>`; for a page without one Chrome shows its URL instead, and that is not
 * a title, so the push goes without one and a phone may still find one: a phone scrapes a
 * received push only while it has no title.
 *
 * Chrome shows that URL formatted for reading (`url_formatter::FormatUrl`): without `http://`,
 * without the slash after a bare host, and with escapes decoded. So the comparison drops the
 * scheme and a trailing slash on both sides and tries the URL decoded too. A host in
 * punycode, which Chrome shows in Unicode, is not decoded here and keeps its URL as a title.
 */
export const titleOfTab = (tabTitle: string | undefined, url: string): string => {
  const raw = tabTitle?.trim() ?? '';
  const title = bare(raw);
  return title === bare(url) || title === bare(decoded(url)) ? '' : raw;
};
