import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';
import { useState } from 'react';

import Button from '@/components/Button';
import { LIMITS, formatMb } from '@/config/plan';
import { usePlan } from '@/hooks/usePlan';
import { KEYS_UNAVAILABLE, usePushKeys } from '@/hooks/usePushKeys';
import { atLimit, isRulesRefusal, limitMessage, refusalMessage } from '@/services/pushRefusal';
import { PushTooLongError, createFilePush, createUrlPush, encryptedSize, keyIsStale } from '@/services/pushes';

import styles from './Push.module.css';

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
    if (plan && atLimit(plan, 'url')) {
      // Read once per mount, so a new period or a subscription in another tab is not seen
      // until it is read again; a refusal here asks for the read, so the next try is right.
      void refreshPlan();
      setError(limitMessage(plan, 'url'));
      return;
    }

    setIsSubmitting(true);

    try {
      // Validate this is a valid URL.
      try {
        new URL(url);
      } catch (error) {
        setError('Invalid URL');
        setIsSubmitting(false);
        return;
      }

      // No title from here: a browser cannot read a cross-origin page, and a server that
      // fetched it for us would learn the URL, which is what the push keeps from it
      // (docs/e2ee.md, Titles). The list shows the URL until the first phone or Mac to
      // receive the push scrapes the title and writes it back.
      const id = await createUrlPush(getFirestore(), keys, url, '');
      console.log('Link saved with ID:', id);

      // Clear form after successful submission
      setUrl('');
    } catch (error) {
      console.error('Error saving link:', error);
      // The limit reached on another device, a key a reset replaced, or a push this copy of
      // PushThat cannot make (pushRefusal.ts); the plan read again stops the next try here.
      setError(
        isRulesRefusal(error)
          ? await refusalMessage(plan, 'url', refreshPlan, () => keyIsStale(getFirestore(), keys))
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
    if (plan && atLimit(plan, 'file')) {
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
      setError(
        isRulesRefusal(error)
          ? await refusalMessage(plan, 'file', refreshPlan, () => keyIsStale(getFirestore(), keys))
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
