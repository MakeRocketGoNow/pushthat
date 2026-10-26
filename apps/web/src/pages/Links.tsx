import {
  DocumentData,
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
import { Push, PushData } from '@/types/pushes';

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

  const fetchPushes = async (search?: string) => {
    if (!user) return;

    try {
      setLoading(true);
      const db = getFirestore();
      const pushesRef = collection(db, 'pushes');

      // Build base query constraints
      const constraints = [where('userId', '==', user.uid), orderBy('createdAt', 'desc'), limit(ITEMS_PER_PAGE)];

      // Add search constraint if search term exists
      if (search?.trim()) {
        // Convert search term to lowercase for case-insensitive search
        const searchLower = search.toLowerCase();
        constraints.push(where('searchTokens', 'array-contains', searchLower));
      }

      const q = query(pushesRef, ...constraints);
      const querySnapshot = await getDocs(q);

      const pushesData = processPushesSnapshot(querySnapshot);

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
    if (!user || !hasMore || !lastDoc || loading) return;

    try {
      setLoading(true);
      const db = getFirestore();
      const pushesRef = collection(db, 'pushes');

      const constraints = [
        where('userId', '==', user.uid),
        orderBy('createdAt', 'desc'),
        startAfter(lastDoc),
        limit(ITEMS_PER_PAGE),
      ];

      if (debouncedSearchTerm?.trim()) {
        const searchLower = debouncedSearchTerm.toLowerCase();
        constraints.push(where('searchTokens', 'array-contains', searchLower));
      }

      const q = query(pushesRef, ...constraints);
      const querySnapshot = await getDocs(q);

      const newPushesData = processPushesSnapshot(querySnapshot);

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

  // Helper function to process snapshot data
  const processPushesSnapshot = (querySnapshot: QuerySnapshot<DocumentData, DocumentData>) => {
    const pushesData: Push[] = [];
    querySnapshot.forEach((doc: QueryDocumentSnapshot<DocumentData>) => {
      const data = doc.data();
      let host = '';
      try {
        host = new URL(data.url).hostname;
      } catch (error) {
        console.error('Error parsing URL:', error);
      }
      const favicon = `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=256`;

      pushesData.push({
        ...(data as PushData),
        id: doc.id,
        favicon,
        createdAt: data.createdAt.toDate(),
      });
    });
    return pushesData;
  };

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
  }, [debouncedSearchTerm, user]); // eslint-disable-line react-hooks/exhaustive-deps

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
        error={error}
        loading={loading && pushes.length === 0}
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
