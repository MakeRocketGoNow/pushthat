import type { PushFile } from './pushes';

/**
 * The file types opened in a tab of their own rather than saved. Raster images only: an
 * object URL takes the app's origin, so an SVG or HTML file opened from one would run
 * its scripts as the signed-in app. Those, and everything else, are saved instead.
 */
const VIEWABLE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif']);

/** The same types by extension, for a file whose envelope names no type. */
const VIEWABLE_EXTENSIONS = new Map([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['avif', 'image/avif'],
]);

/**
 * The type to show a file as in a tab, or undefined to save it. The web list and the
 * extension's worker both ask, so a pushed image opens the same way from either. A push
 * migrated from before encryption has an empty `mime` (`migrationOf` had only the name to
 * go on), and a phone that cannot tell a file's type writes `application/octet-stream` (the
 * Android share sheet, iOS, and this app's own upload all fall back to it). Neither says
 * what the file is, so for both the file extension decides, as the Android app's viewer
 * does.
 */
export const viewableType = (file: PushFile): string | undefined => {
  const mime = file.envelope.mime.toLowerCase();
  if (mime && mime !== 'application/octet-stream') return VIEWABLE_TYPES.has(mime) ? mime : undefined;
  return VIEWABLE_EXTENSIONS.get(file.envelope.ext.toLowerCase());
};
