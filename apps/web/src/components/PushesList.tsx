// cspell:ignore pproj indd flac
import clsx from 'clsx';
import { getStorage } from 'firebase/storage';
import { Dispatch, SetStateAction, useState } from 'react';

import { CheckIcon } from '@/components/icons/CheckIcon';
import { LOCKED_MESSAGE, type Push, type PushFile, downloadFile, viewableType, viewerPath } from '@/services/pushes';

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

/**
 * The linked site's own icon, asked of the site itself: `/favicon.ico` at the link's origin.
 * It used to come from Google's favicon service, which meant telling Google the domain of
 * every link in the list, for pushes whose whole point is that nobody but their owner can
 * read them. A proxy of our own would move the same list to our logs. So the only party
 * asked is the site the link already points at, and when it has no icon there the row
 * falls back to ours.
 *
 * `/favicon.ico` and not the page's `<link rel="icon">`, which the apps read: a browser
 * will draw another origin's image but will not let a script read its HTML. Undefined for
 * anything that is not a web address.
 */
const faviconOf = (url: string | undefined): string | undefined => {
  try {
    const { protocol, origin } = new URL(url ?? '');
    return protocol === 'https:' || protocol === 'http:' ? `${origin}/favicon.ico` : undefined;
  } catch {
    return undefined;
  }
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
 * Where an image push is shown: the page the extension also opens one pushed to this
 * browser on (`ViewPush`, at `viewerPath`), with its name, a download and a way back, and a
 * reload that decrypts it again. `index.html` is a file in both the site and the extension,
 * so the address works in either, and the list opens it as a link, in a tab of its own,
 * rather than decrypting here.
 */
const viewerUrl = (pushId: string) => `/${viewerPath(pushId)}`;

export default function PushesList({
  pushes,
  error,
  loading,
  selectedPushes,
  onSelectedPushesChange,
}: PushesListProps) {
  // The pushes whose site gave no icon (none at `/favicon.ico`, or not an image).
  const [failedIcons, setFailedIcons] = useState<Set<string>>(new Set());
  const [opening, setOpening] = useState<string | undefined>(undefined);
  // What opening a row has to say (a locked push, a file that did not decrypt), shown above
  // the list as the app shows its other errors, not in a browser dialog.
  const [notice, setNotice] = useState<string | undefined>(undefined);

  // An encrypted file that is not an image has no URL to follow: it is read through the
  // SDK, decrypted in the tab (about twice its size in memory at the peak, docs/e2ee.md,
  // Files) and saved. A failure says so and saves nothing, rather than a file cut short.
  const openFile = async (push: Push, file: PushFile) => {
    if (opening) return;
    setOpening(push.id);
    try {
      save(await downloadFile(getStorage(), file), file.envelope.name);
    } catch (error) {
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

  const handleIconError = (pushId: string) => setFailedIcons((prev) => new Set(prev).add(pushId));

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
          // A locked push, or a file with no icon of its own, has no site to ask for one, and
          // neither does a link whose site had none: those get ours.
          const favicon = icon ? undefined : faviconOf(push.url);
          const fallbackSrc =
            push.locked || (!icon && !favicon) || failedIcons.has(push.id) ? '/pushthat-mono.svg' : null;
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
                  <img src={`/files/${icon}`} alt="" className={styles.favicon} />
                ) : (
                  // No referrer: the site learns that its icon was asked for, not by which page.
                  <img
                    src={favicon}
                    alt=""
                    referrerPolicy="no-referrer"
                    className={styles.favicon}
                    onError={() => handleIconError(push.id)}
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
              {/* A link only where there is a page to go to: a URL, or an image's viewer. A
                  locked push and any other encrypted file are opened here, by a button, which
                  a middle-click or a screen reader does not take for a link to this page. */}
              {push.locked || (push.file && !viewableType(push.file)) ? (
                <button
                  type="button"
                  className={clsx(styles.pushLink, styles.pushButton)}
                  onClick={() => handleOpen(push)}
                  aria-busy={opening === push.id}
                >
                  {content}
                </button>
              ) : (
                <a
                  href={push.file ? viewerUrl(push.id) : push.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.pushLink}
                >
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
