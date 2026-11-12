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

/**
 * A file push's icon by its extension. Bundled, and small enough that Vite inlines each one
 * as a data URL (`?inline` makes sure), so drawing the list asks no server anything: served
 * from pushthat.link/files they put the type of every encrypted file a list showed in the
 * hosting logs (docs/e2ee.md, Icons). The PNGs in `public/files` stay, for app versions
 * from before this change, which still load them from there.
 */
// A Map, not an object: an extension comes from a file's name, and an object would answer
// `constructor` or `__proto__` with what it inherits.
const FILE_ICONS = new Map<string, string>(
  Object.entries(
    import.meta.glob<string>('../assets/file-icons/*.svg', { eager: true, query: '?inline', import: 'default' })
  ).map(([path, src]) => [path.slice(path.lastIndexOf('/') + 1, -'.svg'.length), src])
);

/** The placeholder for a push with no icon of its own, and for a locked one. */
const PLACEHOLDER = '/pushthat-mono.svg';

/**
 * What a row's icon shows: a URL push's page icon, else the icon for its type (a link to a
 * PDF has no page to take an icon from), else the placeholder. Never the network: the page
 * icon came with the push. Google's favicon service drew these until it was seen to learn
 * every pushed host from every list (docs/e2ee.md, Icons).
 */
const iconSrc = (push: Push, broken: boolean): string => {
  if (push.locked) return PLACEHOLDER;
  if (push.icon && !broken) return `data:image/png;base64,${push.icon}`;
  return (push.ext && FILE_ICONS.get(push.ext.toLowerCase())) || PLACEHOLDER;
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
  // Page icons that would not decode, which then draw the type's icon or the placeholder.
  // By the icon, not the push, as the phones' caches are: a push whose icon changes while
  // the list is open is drawn with its new one.
  const [brokenIcons, setBrokenIcons] = useState<Set<string>>(new Set());
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
          const isSelected = selectedPushes.has(push.id);
          const content = (
            <>
              <div
                className={clsx(styles.pushIcon, isSelected && styles.selected)}
                onClick={(e) => handleSelect(push.id, e)}
              >
                {isSelected ? (
                  <CheckIcon />
                ) : (
                  <img
                    src={iconSrc(push, !!push.icon && brokenIcons.has(push.icon))}
                    alt=""
                    className={styles.favicon}
                    onError={() => {
                      const { icon } = push;
                      if (icon) setBrokenIcons((prev) => new Set(prev).add(icon));
                    }}
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
