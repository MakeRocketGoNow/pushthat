import {
  DocumentData,
  QueryConstraint,
  QueryDocumentSnapshot,
  QuerySnapshot,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getFirestore,
  limit,
  orderBy,
  query,
  startAfter,
  where,
} from 'firebase/firestore';
import { useEffect, useRef, useState } from 'react';

import Button from '@/components/Button';
import PushesList from '@/components/PushesList';
import { TrashIcon } from '@/components/icons/TrashIcon';
import { useAuth } from '@/contexts/AuthContext';
import { useDebounce } from '@/hooks/useDebounce';
import { usePushKeys } from '@/hooks/usePushKeys';
import { type Push, type PushKeys, readPush, searchTokenFor } from '@/services/pushes';

import styles from './Links.module.css';

const ITEMS_PER_PAGE = 20;
const REFRESH_COOL_DOWN = 60000; // 1 minute in milliseconds

export default function Links() {
  const { user } = useAuth();
  const [error, setError] = useState<string | undefined>(undefined);
  const [pushes, setPushes] = useState<Push[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDeleting, setIsDeleting] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [selectedPushes, setSelectedPushes] = useState<Set<string>>(new Set());
  const debouncedSearchTerm = useDebounce(searchTerm, 500); // 500ms delay
  const [hasMore, setHasMore] = useState(true);
  const [lastDoc, setLastDoc] = useState<QueryDocumentSnapshot | null>(null);
  const observerTarget = useRef<HTMLDivElement>(null);
  const lastRefreshTime = useRef<number>(Date.now());
  const { keys, failed: keysFailed } = usePushKeys();

  // The search, as the stored tokens have it: the blind token of the term's first word
  // (docs/e2ee.md, Search). A plaintext push not yet migrated is not found by a search,
  // only listed; the migration that runs on sign-in is what makes it findable again.
  const searchConstraints = async (keys: PushKeys, search?: string): Promise<QueryConstraint[]> => {
    const token = search ? await searchTokenFor(keys, search) : undefined;
    return token ? [where('searchTokens', 'array-contains', token)] : [];
  };

  const fetchPushes = async (search?: string) => {
    if (!user || !keys) return;

    try {
      setLoading(true);
      const db = getFirestore();
      const pushesRef = collection(db, 'pushes');

      const constraints = [
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        limit(ITEMS_PER_PAGE),
        ...(await searchConstraints(keys, search)),
      ];

      const q = query(pushesRef, ...constraints);
      const querySnapshot = await getDocs(q);

      const pushesData = await processPushesSnapshot(querySnapshot, keys);

      setLastDoc(querySnapshot.docs[querySnapshot.docs.length - 1] || null);
      setHasMore(querySnapshot.docs.length === ITEMS_PER_PAGE);
      setLoading(false);
      setPushes(pushesData);
    } catch (error) {
      console.error('Error fetching pushes:', error);
      setError('Failed to fetch pushes');
      setLoading(false);
    }
  };

  const loadMore = async () => {
    if (!user || !keys || !hasMore || !lastDoc || loading) return;

    try {
      setLoading(true);
      const db = getFirestore();
      const pushesRef = collection(db, 'pushes');

      const constraints = [
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        startAfter(lastDoc),
        limit(ITEMS_PER_PAGE),
        ...(await searchConstraints(keys, debouncedSearchTerm)),
      ];

      const q = query(pushesRef, ...constraints);
      const querySnapshot = await getDocs(q);

      const newPushesData = await processPushesSnapshot(querySnapshot, keys);

      setLastDoc(querySnapshot.docs[querySnapshot.docs.length - 1] || null);
      setHasMore(querySnapshot.docs.length === ITEMS_PER_PAGE);
      setPushes((prev) => [...prev, ...newPushesData]);
      setLoading(false);
    } catch (error) {
      console.error('Error loading more pushes:', error);
      setError('Failed to load more pushes');
      setLoading(false);
    }
  };

  // Each push in whichever shape it was stored, decrypted where it is encrypted.
  const processPushesSnapshot = (querySnapshot: QuerySnapshot<DocumentData, DocumentData>, keys: PushKeys) =>
    Promise.all(querySnapshot.docs.map((doc: QueryDocumentSnapshot<DocumentData>) => readPush(doc, keys)));

  // Set up intersection observer
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore) {
          loadMore();
        }
      },
      { threshold: 0.5 }
    );

    if (observerTarget.current) {
      observer.observe(observerTarget.current);
    }

    return () => observer.disconnect();
  }, [hasMore, lastDoc]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    setLastDoc(null);
    setHasMore(true);
    setPushes([]);
    fetchPushes(debouncedSearchTerm);
  }, [debouncedSearchTerm, user, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        const now = Date.now();
        // Check if enough time has passed since the last refresh
        if (now - lastRefreshTime.current >= REFRESH_COOL_DOWN) {
          lastRefreshTime.current = now;
          fetchPushes(debouncedSearchTerm);
        }
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
    };
  }, [debouncedSearchTerm]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle search input changes
  const handleSearch = (event: React.ChangeEvent<HTMLInputElement>) => {
    setSearchTerm(event.target.value);
  };

  const handleSelectAll = () => {
    if (selectedPushes.size === pushes.length) {
      setSelectedPushes(new Set());
    } else {
      setSelectedPushes(new Set(pushes.map((p) => p.id)));
    }
  };

  const handleDelete = async () => {
    if (selectedPushes.size === 0) return;

    try {
      setIsDeleting(true);
      const db = getFirestore();
      const deletePromises = Array.from(selectedPushes).map((pushId) => deleteDoc(doc(db, 'pushes', pushId)));

      await Promise.all(deletePromises);

      // Remove deleted pushes from state
      setPushes((prevPushes) => prevPushes.filter((push) => !selectedPushes.has(push.id)));

      // Clear selection
      setSelectedPushes(new Set());
    } catch (error) {
      console.error('Error deleting pushes:', error);
      setError('Failed to delete pushes');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div>
      <div className={styles.searchContainer}>
        {selectedPushes.size > 0 ? (
          <div className={styles.actionBar}>
            <button onClick={handleSelectAll} className={styles.selectAllButton}>
              {selectedPushes.size === pushes.length ? 'Deselect All' : 'Select All'}
            </button>
            <Button
              outline
              onClick={handleDelete}
              className={styles.deleteButton}
              aria-label="Delete selected pushes"
              title="Delete selected pushes"
              disabled={isDeleting}
            >
              {isDeleting ? <div className={styles.spinner} /> : <TrashIcon />}
            </Button>
          </div>
        ) : (
          <input
            type="search"
            placeholder="Search pushes..."
            value={searchTerm}
            onChange={handleSearch}
            className={styles.searchInput}
          />
        )}
      </div>

      <PushesList
        pushes={pushes}
        error={keysFailed ? 'Your encryption key could not be read on this device. Reload the page.' : error}
        loading={(loading || (!keys && !keysFailed)) && pushes.length === 0}
        selectedPushes={selectedPushes}
        onSelectedPushesChange={setSelectedPushes}
      />

      {/* Infinite scroll observer target */}
      <div ref={observerTarget} style={{ height: '20px' }}>
        {loading && pushes.length > 0 && <div className={styles.loadingMore}>Loading more...</div>}
      </div>
    </div>
  );
}
