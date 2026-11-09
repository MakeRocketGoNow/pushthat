import { ArrowDownTrayIcon } from '@heroicons/react/24/outline';
import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import Button from '@/components/Button';
import { KEYS_UNAVAILABLE, usePushKeys } from '@/hooks/usePushKeys';
import { LOCKED_MESSAGE, downloadFile, readPush, viewableType } from '@/services/pushes';

import styles from './ViewPush.module.css';

type View =
  | { name: 'loading' }
  | { name: 'shown'; src: string; title: string; type: string; size: number; createdAt: Date }
  | { name: 'failed'; message: string };

/** `image/jpeg` as `JPEG`: what the bar says the file is. */
const typeLabel = (type: string) => type.replace(/^image\//, '').toUpperCase();

const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

/**
 * One pushed image, decrypted and shown on a page of its own: where the extension opens an
 * image pushed to this browser, as it opened a pushed file's Storage URL before encryption.
 * It is outside the site's `Layout` (no menu, no frame): a bar with the file and a download,
 * and the image fitted below it on a dark ground, the way Chrome shows an image it opens.
 *
 * It is an `<img>` in this page rather than the tab navigated to the image's object URL,
 * which shows it in Chrome's own viewer: tried, and the tab was then titled with the
 * `blob:` id, and a reload found the URL gone with the page that made it and showed
 * Chrome's error page. Only the types `viewableType` allows are shown, and an `<img>` runs
 * no script whatever the bytes say; anything else is opened from the list.
 */
export function ViewPush({ pushId }: { pushId: string }) {
  const { keys, failed: keysFailed } = usePushKeys();
  const [view, setView] = useState<View>({ name: 'loading' });

  useEffect(() => {
    if (!keys) return;
    let cancelled = false;
    let src: string | undefined;
    (async (): Promise<View> => {
      const push = await readPush(await getDoc(doc(getFirestore(), 'pushes', pushId)), keys);
      if (push.locked) return { name: 'failed', message: LOCKED_MESSAGE };
      const type = push.file && viewableType(push.file);
      if (!push.file || !type) return { name: 'failed', message: 'This push is not an image to show here.' };
      const blob = await downloadFile(getStorage(), push.file);
      // Retyped to the checked type, not trusted as it came: a file stored before
      // encryption comes back with whatever Content-Type Storage holds for it.
      src = URL.createObjectURL(new Blob([blob], { type }));
      // The size from the bytes: a push migrated from before encryption records none.
      return { name: 'shown', src, title: push.title, type, size: blob.size, createdAt: push.createdAt };
    })()
      .catch((error: unknown): View => {
        console.error('Error showing a pushed image:', error);
        return { name: 'failed', message: 'This image could not be opened. It may have been deleted.' };
      })
      .then((next) => {
        if (!cancelled) setView(next);
        else if (src) URL.revokeObjectURL(src);
      });
    // The object URL holds the whole image, and the download reads it too; it goes when the
    // page does, or as soon as it is made if the page went first.
    return () => {
      cancelled = true;
      if (src) URL.revokeObjectURL(src);
    };
  }, [pushId, keys]);

  useEffect(() => {
    document.title = view.name === 'shown' ? view.title : view.name === 'loading' ? 'Decrypting…' : 'PushThat';
  }, [view]);

  // From the URL this page already holds, so the file is not read or decrypted again.
  const download = () => {
    if (view.name !== 'shown') return;
    const link = document.createElement('a');
    link.href = view.src;
    link.download = view.title;
    link.click();
  };

  const failure = keysFailed ? KEYS_UNAVAILABLE : view.name === 'failed' ? view.message : undefined;

  return (
    <div className={styles.page}>
      <header className={styles.bar}>
        <Link to="/links" className={styles.home} title="Your pushes">
          <img src="/pushthat-mono.svg" alt="PushThat" className={styles.logo} />
        </Link>
        <div className={styles.file}>
          {view.name === 'shown' ? (
            <>
              <h1 className={styles.name} title={view.title}>
                {view.title}
              </h1>
              <p className={styles.meta}>
                {typeLabel(view.type)} · {sizeLabel(view.size)} · pushed {view.createdAt.toLocaleString()}
              </p>
            </>
          ) : (
            <h1 className={styles.name}>{failure ? 'PushThat' : 'Decrypting…'}</h1>
          )}
        </div>
        {view.name === 'shown' && (
          <Button solid onClick={download} className={styles.download} aria-label={`Download ${view.title}`}>
            <ArrowDownTrayIcon className={styles.downloadIcon} aria-hidden="true" />
            <span className={styles.downloadLabel}>Download</span>
          </Button>
        )}
      </header>
      <main className={styles.stage}>
        {failure ? (
          <p className={styles.message}>
            {failure}{' '}
            <Link to="/links" className={styles.messageLink}>
              Your pushes
            </Link>
          </p>
        ) : view.name === 'shown' ? (
          <img src={view.src} alt={view.title} className={styles.image} />
        ) : (
          <div className={styles.spinner} role="status" aria-label="Decrypting" />
        )}
      </main>
    </div>
  );
}
