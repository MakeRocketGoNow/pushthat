import { doc, getDoc, getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';

import { KEYS_UNAVAILABLE, usePushKeys } from '@/hooks/usePushKeys';
import { LOCKED_MESSAGE, downloadFile, readPush, viewableType } from '@/services/pushes';

import styles from './ViewPush.module.css';

type View =
  | { name: 'loading' }
  | { name: 'shown'; src: string; title: string }
  | { name: 'failed'; message: string; toList?: boolean };

/**
 * One pushed image, decrypted and shown with nothing around it: where the extension opens
 * an image pushed to this browser, as it opened a pushed file's Storage URL before
 * encryption. The image is centered and fitted to the window on a dark ground, the way
 * Chrome shows an image it opens, and the tab is titled with the file's name.
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
    (async () => {
      const push = await readPush(await getDoc(doc(getFirestore(), 'pushes', pushId)), keys);
      if (push.locked) return { name: 'failed', message: LOCKED_MESSAGE } as const;
      const type = push.file && viewableType(push.file);
      if (!push.file || !type) {
        return { name: 'failed', message: 'This push is not an image to show here.', toList: true } as const;
      }
      const blob = await downloadFile(getStorage(), push.file);
      // Retyped to the checked type, not trusted as it came: a file stored before
      // encryption comes back with whatever Content-Type Storage holds for it.
      src = URL.createObjectURL(new Blob([blob], { type }));
      return { name: 'shown', src, title: push.title } as const;
    })()
      .catch((error: unknown): View => {
        console.error('Error showing a pushed image:', error);
        return { name: 'failed', message: 'This image could not be opened. It may have been deleted.', toList: true };
      })
      .then((next) => {
        if (!cancelled) setView(next);
        else if (src) URL.revokeObjectURL(src);
      });
    // The object URL holds the whole image; it goes when the page does, or as soon as it is
    // made if the page went first.
    return () => {
      cancelled = true;
      if (src) URL.revokeObjectURL(src);
    };
  }, [pushId, keys]);

  useEffect(() => {
    document.title = view.name === 'shown' ? view.title : view.name === 'loading' ? 'Decrypting…' : 'PushThat';
  }, [view]);

  return (
    <div className={styles.viewer}>
      {keysFailed ? (
        <p className={styles.message}>{KEYS_UNAVAILABLE}</p>
      ) : view.name === 'loading' ? (
        <p className={styles.message}>Decrypting…</p>
      ) : view.name === 'failed' ? (
        <p className={styles.message}>
          {view.message} {view.toList && <Link to="/links">Your pushes</Link>}
        </p>
      ) : (
        <img src={view.src} alt={view.title} className={styles.image} />
      )}
    </div>
  );
}
