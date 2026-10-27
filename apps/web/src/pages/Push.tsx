import { FirebaseError } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getFunctions, httpsCallable } from 'firebase/functions';
import { getStorage } from 'firebase/storage';
import { useState } from 'react';

import Button from '@/components/Button';
import { LIMITS, formatMb } from '@/config/plan';
import { usePlan } from '@/hooks/usePlan';
import { KEYS_UNAVAILABLE, usePushKeys } from '@/hooks/usePushKeys';
import { PlanReport } from '@/services/plan';
import {
  type PushKeys,
  PushTooLongError,
  createFilePush,
  createUrlPush,
  encryptedSize,
  keyIsStale,
} from '@/services/pushes';

import styles from './Push.module.css';

/**
 * Why the rules refused a push, if they did. They say both the month's limit and a key a
 * reset elsewhere has replaced (`isCurrentKeyVersion`) as a permission error, the only two
 * of the create rule's refusals this page's own documents can hit; the second is told apart
 * by reading the account's current version. It is not the plan's doing, and trying again
 * cannot help: only signing in again stores the new key.
 */
const refusalOf = async (error: unknown, keys: PushKeys): Promise<'limit' | 'staleKey' | undefined> => {
  if (!(error instanceof FirebaseError && error.code === 'permission-denied')) return undefined;
  return (await keyIsStale(getFirestore(), keys)) ? 'staleKey' : 'limit';
};

// Word for word what Android says (keys_changed_here).
const STALE_KEY = 'Your encryption keys were changed on another device. Sign out and sign in again to use them here.';

/** The sentence for a push past the month's limit, naming the number and, on Free, what Pro allows. */
const limitMessage = (plan: PlanReport | undefined, type: 'url' | 'file') => {
  const what = type === 'url' ? 'link' : 'file';
  if (!plan) return `You have used this month's ${what} pushes.`;
  const more = plan.tier === 'free' ? ` Pro allows ${LIMITS.pro[type].toLocaleString()}.` : '';
  return `You have used this month's ${plan.limits[type].toLocaleString()} ${what} pushes.${more}`;
};

export default function Push() {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadSubmitting, setIsUploadSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { plan, refresh: refreshPlan } = usePlan();
  const { keys } = usePushKeys();

  const handleLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!url) return;
    if (!keys) {
      setError(KEYS_UNAVAILABLE);
      return;
    }

    // Said before anything is sent: at 50 a month a Free account reaches this routinely.
    // The plan read once per mount can be stale, so the refusal below is handled too.
    if (plan && plan.usage.url >= plan.limits.url) {
      // Read once per mount, so a new period or a subscription in another tab is not seen
      // until it is read again; a refusal here asks for the read, so the next try is right.
      void refreshPlan();
      setError(limitMessage(plan, 'url'));
      return;
    }

    setIsSubmitting(true);

    try {
      // Empty when the page has none to give: the list shows the URL meanwhile, and the
      // first phone or Mac to receive the push scrapes the title and writes it back.
      let finalTitle = '';

      // Validate this is a valid URL.
      try {
        new URL(url);
      } catch (error) {
        setError('Invalid URL');
        setIsSubmitting(false);
        return;
      }

      // Until phase 5 of docs/e2ee.md, which removes the function: a server that fetches the
      // page learns the URL, which is the one thing the push otherwise keeps from it.
      try {
        const functions = getFunctions();
        const getPageTitle = httpsCallable(functions, 'getPageTitle');
        const result = await getPageTitle({ url });
        const data = result.data as { title: string };
        if (data.title) {
          finalTitle = data.title;
        }
      } catch (error) {
        console.error('Error fetching page title:', error);
      }

      const id = await createUrlPush(getFirestore(), keys, url, finalTitle);
      console.log('Link saved with ID:', id);

      // Clear form after successful submission
      setUrl('');
    } catch (error) {
      console.error('Error saving link:', error);
      const refusal = await refusalOf(error, keys);
      // The limit reached on another device: read the plan again so the next try is stopped here.
      if (refusal === 'limit') void refreshPlan();
      setError(
        refusal === 'limit'
          ? limitMessage(plan, 'url')
          : refusal === 'staleKey'
            ? STALE_KEY
            : error instanceof PushTooLongError
              ? 'That link is too long to push.'
              : 'Failed to save link. Please try again.'
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) return;
    if (!keys) {
      setError(KEYS_UNAVAILABLE);
      return;
    }

    // The tier's file size, which the Storage rules enforce; said here before the upload
    // starts. Without the plan read (offline, say) the larger limit is assumed and the
    // rules have the last word.
    const limits = plan?.limits ?? LIMITS.pro;
    // `>=`, as the Storage rule has it: a file of exactly the limit is refused there. The
    // rule measures the encrypted object, a few bytes a megabyte larger than the file.
    if (encryptedSize(file.size) >= limits.fileBytes) {
      setError(
        `File size must be under ${formatMb(limits.fileBytes)}${plan?.tier === 'free' ? ` on the free plan (${formatMb(LIMITS.pro.fileBytes)} on Pro)` : ''}.`
      );
      return;
    }
    // The file is uploaded before the push document is made, and only the document is
    // checked against the quota, so a refused push would leave its bytes in Storage with
    // nothing to ever delete them. Refused here first, with the plan already in hand.
    if (plan && plan.usage.file >= plan.limits.file) {
      void refreshPlan();
      setError(limitMessage(plan, 'file'));
      return;
    }

    setIsUploadSubmitting(true);

    try {
      // Encrypted in the tab, stored under a random name; a refused push takes its upload
      // with it (createFilePush), since nothing else would ever name the object.
      const id = await createFilePush(getFirestore(), getStorage(), keys, file);
      console.log('File saved with ID:', id);

      // Clear form after successful submission
      setFile(null);
      // Reset the file input by clearing its value
      const fileInput = document.getElementById('file') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    } catch (error) {
      console.error('Error saving file:', error);
      const refusal = await refusalOf(error, keys);
      if (refusal === 'limit') void refreshPlan();
      setError(
        refusal === 'limit'
          ? limitMessage(plan, 'file')
          : refusal === 'staleKey'
            ? STALE_KEY
            : error instanceof PushTooLongError
              ? 'That file name is too long to push.'
              : 'Failed to upload file. Please try again.'
      );
    } finally {
      setIsUploadSubmitting(false);
    }
  };

  const handleUrlChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const newUrl = e.target.value;
    setUrl(newUrl);
  };

  return (
    <div>
      <h1>Push</h1>
      {error && <div className={styles.error}>{error}</div>}

      <form onSubmit={handleLinkSubmit} className={styles.form}>
        <div className={styles.inputGroup}>
          <label htmlFor="url">Link:</label>
          <input
            type="text"
            id="url"
            value={url}
            onChange={handleUrlChange}
            placeholder="Enter URL"
            required
            className={styles.input}
          />
        </div>
        <Button type="submit" isSubmitting={isSubmitting} outline>
          {isSubmitting ? 'Pushing...' : 'Push Link'}
        </Button>
      </form>

      <div className={styles.divider}>
        <span>OR</span>
      </div>

      <form onSubmit={handleFileSubmit} className={styles.form}>
        <div className={styles.inputGroup}>
          <label htmlFor="file">File:</label>
          <input
            type="file"
            id="file"
            onChange={(e) => setFile(e.target.files?.[0] || null)}
            required
            className={styles.input}
          />
        </div>
        <Button type="submit" isSubmitting={isUploadSubmitting} outline>
          {isUploadSubmitting ? 'Pushing...' : 'Push File'}
        </Button>
      </form>
    </div>
  );
}
