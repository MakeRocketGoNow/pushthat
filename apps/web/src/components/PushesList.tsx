// cspell:ignore pproj indd flac
import clsx from 'clsx';
import { getStorage } from 'firebase/storage';
import { Dispatch, SetStateAction, useState } from 'react';

import { CheckIcon } from '@/components/icons/CheckIcon';
import { LOCKED_MESSAGE, type Push, type PushFile, downloadFile } from '@/services/pushes';

import styles from './PushesList.module.css';

interface PushesListProps {
  pushes: Push[];
  error?: string;
  loading?: boolean;
  selectedPushes: Set<string>;
  onSelectedPushesChange: Dispatch<SetStateAction<Set<string>>>;
}

const ICONS = [
  'pproj.svg',
  'zip.svg',
  'indd.svg',
  'csv.svg',
  'css.svg',
  'pdf.svg',
  'aac.svg',
  'png.svg',
  'xls.svg',
  'avi.svg',
  'txt.svg',
  'mp3.svg',
  'tiff.svg',
  'psd.svg',
  'jpg.svg',
  'jpeg.svg',
  'mov.svg',
  'html.svg',
  'ai.svg',
  'js.svg',
  'flac.svg',
  'mp4.svg',
  'gif.svg',
  'doc.svg',
  'xml.svg',
  'apk.svg',
];

const faviconOf = (url: string | undefined): string => {
  let host = '';
  try {
    host = url ? new URL(url).hostname : '';
  } catch (error) {
    console.error('Error parsing URL:', error);
  }
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=256`;
};

/**
 * Hands a decrypted file to the browser as a download. The object URL is revoked once the
 * save has had time to start, or a 100 MB Blob would be held for the life of the tab. Not
 * at once: Safari, and Firefox in some versions, cancel a download whose URL goes away
 * before they have begun reading it, which is why FileSaver.js waits 40 seconds too.
 */
const save = (blob: Blob, name: string) => {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
};

/**
 * The file types opened in a tab of their own rather than saved. Raster images only: an
 * object URL takes this page's origin, so an SVG or HTML file opened from one would run
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
 * The type to show a file as in a tab, or undefined to save it. A push migrated from before
 * encryption has an empty `mime` (`migrationOf` had only the name to go on), so for it the
 * extension decides, as the Android app does when the type is blank.
 */
const viewableType = (file: PushFile): string | undefined => {
  const mime = file.envelope.mime.toLowerCase();
  if (mime) return VIEWABLE_TYPES.has(mime) ? mime : undefined;
  return VIEWABLE_EXTENSIONS.get(file.envelope.ext.toLowerCase());
};

/**
 * Shows a decrypted image in a tab already opened for it. The Blob is retyped from the
 * type `viewableType` checked, not trusted as it came: a file stored before encryption
 * comes back with whatever Content-Type Storage holds for it. The URL is revoked after the same
 * wait as a save, long enough for the tab to load it; reloading that tab later finds it
 * gone, which is the price of not holding every opened image for the life of this tab.
 */
const view = (tab: Window, blob: Blob, mime: string) => {
  const url = URL.createObjectURL(new Blob([blob], { type: mime }));
  tab.location.href = url;
  setTimeout(() => URL.revokeObjectURL(url), 40_000);
};

export default function PushesList({
  pushes,
  error,
  loading,
  selectedPushes,
  onSelectedPushesChange,
}: PushesListProps) {
  const [lowResImages, setLowResImages] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState<string | undefined>(undefined);
  // What opening a row has to say (a locked push, a file that did not decrypt), shown above
  // the list as the app shows its other errors, not in a browser dialog.
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // An encrypted file has no URL to follow: it is read through the SDK, decrypted in the
  // tab (about twice its size in memory at the peak, docs/e2ee.md, Files) and saved, or for
  // an image, shown in a new tab as it was before encryption. A failure says so and saves
  // nothing, rather than a file cut short.
  const openFile = async (push: Push, file: PushFile) => {
    if (opening) return;
    setOpening(push.id);
    // The tab is opened now, inside the click: a `window.open` after the `await` below is a
    // pop-up to the browser. Opened blank, so `noopener` cannot be asked for (it makes
    // `window.open` answer null), and the opener is cut by hand. A blocked tab (null) falls
    // back to saving the image.
    const type = viewableType(file);
    const tab = type ? window.open('', '_blank') : null;
    if (tab) {
      tab.opener = null;
      // The tab is in front from here on, so it says what it is waiting for rather than
      // standing blank; the row's "Decrypting" is in the tab the user just left. The name is
      // set as text, never as markup.
      tab.document.title = file.envelope.name;
      tab.document.body.textContent = 'Decrypting…';
    }
    try {
      const blob = await downloadFile(getStorage(), file);
      if (tab && type) view(tab, blob, type);
      else save(blob, file.envelope.name);
    } catch (error) {
      tab?.close();
      console.error('Error opening file:', error);
      setNotice('This file could not be decrypted.');
    } finally {
      setOpening(undefined);
    }
  };

  // A row with no URL to follow: a locked push, or an encrypted file.
  const handleOpen = (push: Push) => {
    setNotice(undefined);
    if (push.locked) setNotice(LOCKED_MESSAGE);
    else if (push.file) void openFile(push, push.file);
  };

  const handleSelect = (pushId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();

    onSelectedPushesChange((prev) => {
      const newSet = new Set(prev);
      if (newSet.has(pushId)) {
        newSet.delete(pushId);
      } else {
        newSet.add(pushId);
      }
      return newSet;
    });
  };

  const handleImageLoad = (event: React.SyntheticEvent<HTMLImageElement>, pushId: string) => {
    const image = event.currentTarget;
    if (image.naturalHeight === 16) {
      setLowResImages((prev) => new Set(prev).add(pushId));
    }
  };

  const getFallbackImageSrc = (push: Push, icon: string | undefined) => {
    // If this push has a low-res image, use the PushThat logo as fallback
    if (lowResImages.has(push.id)) {
      return '/pushthat-mono.svg';
    }
    return null;
  };

  if (loading) {
    return <div className={styles.textContainer}>Loading...</div>;
  }

  if (pushes.length === 0) {
    return (
      <div className={clsx(styles.textContainer, error && styles.errorContainer)}>
        <p>{error || 'No links found'}</p>
      </div>
    );
  }

  return (
    <>
      {notice && (
        <div className={styles.notice} role="alert">
          {notice}
        </div>
      )}
      <ul className={styles.pushesList}>
        {pushes.map((push) => {
          const icon = ICONS.find((icon) => push.ext === icon.split('.')[0]);
          const isSelected = selectedPushes.has(push.id);
          // A locked push, or a file with no icon of its own, has no host to ask for a
          // favicon (and an empty one would still ask Google).
          const fallbackSrc =
            push.locked || (!icon && !push.url) ? '/pushthat-mono.svg' : getFallbackImageSrc(push, icon);
          const content = (
            <>
              <div
                className={clsx(styles.pushIcon, isSelected && styles.selected)}
                onClick={(e) => handleSelect(push.id, e)}
              >
                {isSelected ? (
                  <CheckIcon />
                ) : fallbackSrc ? (
                  <img src={fallbackSrc} alt="" className={styles.favicon} />
                ) : icon ? (
                  <img
                    src={`/files/${icon}`}
                    alt=""
                    className={styles.favicon}
                    onLoad={(e) => handleImageLoad(e, push.id)}
                  />
                ) : (
                  <img
                    src={faviconOf(push.url)}
                    alt=""
                    className={styles.favicon}
                    onLoad={(e) => handleImageLoad(e, push.id)}
                  />
                )}
              </div>
              <div className={styles.pushContent}>
                <span className={styles.pushTitle}>
                  {opening === push.id ? `Decrypting ${push.title}…` : push.title || push.url}
                </span>
                <div className={styles.pushMeta}>{new Date(push.createdAt).toLocaleString()}</div>
              </div>
            </>
          );

          return (
            <li key={push.id} className={styles.pushItem}>
              {/* A link only where there is a page to go to: a locked push and an encrypted
                  file are opened here, by a button, which a middle-click or a screen reader
                  does not take for a link to this page. */}
              {push.locked || push.file ? (
                <button
                  type="button"
                  className={clsx(styles.pushLink, styles.pushButton)}
                  onClick={() => handleOpen(push)}
                  aria-busy={opening === push.id}
                >
                  {content}
                </button>
              ) : (
                <a href={push.url} target="_blank" rel="noopener noreferrer" className={styles.pushLink}>
                  {content}
                </a>
              )}
            </li>
          );
        })}
      </ul>
    </>
  );
}
