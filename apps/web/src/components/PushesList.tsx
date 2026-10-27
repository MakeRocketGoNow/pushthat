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
  // tab (about twice its size in memory at the peak, docs/e2ee.md, Files) and saved. A
  // failure says so and saves nothing, rather than a file cut short.
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
