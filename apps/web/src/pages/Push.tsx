import { FirebaseError } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { addDoc, collection, getFirestore, serverTimestamp } from 'firebase/firestore';
import {
  StorageError,
  StorageReference,
  deleteObject,
  getDownloadURL,
  getStorage,
  ref,
  uploadBytes,
} from 'firebase/storage';
import { useState } from 'react';

import Button from '@/components/Button';
import { LIMITS, formatMb } from '@/config/plan';
import { usePlan } from '@/hooks/usePlan';
import { PlanReport } from '@/services/plan';

import styles from './Push.module.css';

/** The rules refuse a push past the month's limit as a permission error: the only one of the create rule's refusals this page's own documents can hit. */
const isLimitRefusal = (error: unknown) => error instanceof FirebaseError && error.code === 'permission-denied';

/** The sentence for a push past the month's limit, naming the number and, on Free, what Pro allows. */
const limitMessage = (plan: PlanReport | undefined, type: 'url' | 'file') => {
  const what = type === 'url' ? 'link' : 'file';
  if (!plan) return `You have used this month's ${what} pushes.`;
  const more = plan.tier === 'free' ? ` Pro allows ${LIMITS.pro[type].toLocaleString()}.` : '';
  return `You have used this month's ${plan.limits[type].toLocaleString()} ${what} pushes.${more}`;
};

const generateSearchTokens = (text: string): string[] => {
  // Convert to lowercase and split into words
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '') // Remove special characters
    .split(/\s+/); // Split on whitespace

  const tokens = new Set<string>();

  // Add full words
  words.forEach((word) => {
    if (word) tokens.add(word);
  });

  // Add partial matches (substrings)
  words.forEach((word) => {
    for (let i = 1; i <= word.length; i++) {
      tokens.add(word.substring(0, i));
    }
  });

  return Array.from(tokens);
};

const generateUniqueFileName = (originalName: string, attempt: number = 0): string => {
  const lastDotIndex = originalName.lastIndexOf('.');
  if (lastDotIndex === -1) {
    return attempt === 0 ? originalName : `${originalName} (${attempt})`;
  }

  const nameWithoutExt = originalName.slice(0, lastDotIndex);
  const extension = originalName.slice(lastDotIndex);
  return attempt === 0 ? originalName : `${nameWithoutExt} (${attempt})${extension}`;
};

const checkFileExists = async (storageRef: StorageReference): Promise<boolean> => {
  try {
    await getDownloadURL(storageRef);
    return true;
  } catch (error: unknown) {
    if ((error as StorageError).code === 'storage/object-not-found') {
      return false;
    }
    throw error;
  }
};

const getUniqueStorageRef = async (
  storage: ReturnType<typeof getStorage>,
  userId: string,
  fileName: string
): Promise<StorageReference> => {
  let attempt = 0;
  let uniqueFileName = fileName;
  let storageRef = ref(storage, `uploads/${userId}/${uniqueFileName}`);

  while (await checkFileExists(storageRef)) {
    attempt++;
    uniqueFileName = generateUniqueFileName(fileName, attempt);
    storageRef = ref(storage, `uploads/${userId}/${uniqueFileName}`);
  }

  return storageRef;
};

export default function Push() {
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isUploadSubmitting, setIsUploadSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { plan, refresh: refreshPlan } = usePlan();

  const createPushDocument = (url: string, title: string, type: 'url' | 'file', ext?: string) => {
    const auth = getAuth();

    // Generate search tokens from both URL and title
    const searchText = `${url} ${title}`;
    const searchTokens = generateSearchTokens(searchText);

    return {
      url,
      userId: auth.currentUser?.uid,
      createdAt: serverTimestamp(),
      title,
      type,
      deviceName: navigator.userAgent,
      searchTokens, // Add searchTokens field
      ...(ext && { ext }),
    };
  };

  const handleLinkSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!url) return;

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
      const db = getFirestore();
      const push = createPushDocument(url, '', 'url');

      const docRef = await addDoc(collection(db, 'pushes'), push);
      console.log('Link saved with ID:', docRef.id);

      // Clear form after successful submission
      setUrl('');
    } catch (error) {
      console.error('Error saving link:', error);
      // The limit reached on another device: read the plan again so the next try is stopped here.
      if (isLimitRefusal(error)) void refreshPlan();
      setError(isLimitRefusal(error) ? limitMessage(plan, 'url') : 'Failed to save link. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleFileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!file) return;

    // The tier's file size, which the Storage rules enforce; said here before the upload
    // starts. Without the plan read (offline, say) the larger limit is assumed and the
    // rules have the last word.
    const limits = plan?.limits ?? LIMITS.pro;
    // `>=`, as the Storage rule has it: a file of exactly the limit is refused there.
    if (file.size >= limits.fileBytes) {
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

    let uploaded: StorageReference | null = null;
    try {
      const auth = getAuth();
      const storage = getStorage();
      const db = getFirestore();

      if (!auth.currentUser?.uid) {
        throw new Error('User not authenticated');
      }

      const ext = file.name.split('.').pop()?.toLowerCase() || '';

      // Get a unique storage reference
      const storageRef = await getUniqueStorageRef(storage, auth.currentUser.uid, file.name);

      const snapshot = await uploadBytes(storageRef, file);
      uploaded = snapshot.ref;
      const downloadUrl = await getDownloadURL(snapshot.ref);

      // Use the final file name from the storage reference for the title
      const finalFileName = storageRef.name.split('/').pop() || file.name;
      const push = createPushDocument(downloadUrl, finalFileName, 'file', ext);

      const docRef = await addDoc(collection(db, 'pushes'), push);
      console.log('File saved with ID:', docRef.id);

      // Clear form after successful submission
      setFile(null);
      // Reset the file input by clearing its value
      const fileInput = document.getElementById('file') as HTMLInputElement;
      if (fileInput) fileInput.value = '';
    } catch (error) {
      console.error('Error saving file:', error);
      // A push refused after its upload (the stale-plan case, or a limit reached in
      // another tab) would otherwise leave the object behind for good.
      if (uploaded) await deleteObject(uploaded).catch((e) => console.error('Error removing the upload:', e));
      if (isLimitRefusal(error)) void refreshPlan();
      setError(isLimitRefusal(error) ? limitMessage(plan, 'file') : 'Failed to upload file. Please try again.');
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
