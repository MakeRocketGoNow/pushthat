import { getFirestore } from 'firebase/firestore';
import { useEffect, useState } from 'react';

import { useAuth } from '@/contexts/AuthContext';
import { useKeys } from '@/contexts/KeysContext';
import { type PushKeys, loadPushKeys } from '@/services/pushes';

/**
 * The keys this device writes and reads pushes with, once `KeyGate` has let the page in.
 * `keys` is undefined while they are read; `failed` says they could not be, which on a
 * page behind the gate means IndexedDB refused (a private window that blocks it, say).
 */
export function usePushKeys(): { keys: PushKeys | undefined; failed: boolean } {
  const { user } = useAuth();
  const { step } = useKeys();
  const [keys, setKeys] = useState<PushKeys | undefined>(undefined);
  const [failed, setFailed] = useState(false);
  const uid = user?.uid;
  const ready = step.name === 'ready';

  useEffect(() => {
    setKeys(undefined);
    setFailed(false);
    if (!uid || !ready) return;
    let current = true;
    loadPushKeys(getFirestore(), uid).then(
      (loaded) => {
        if (!current) return;
        setKeys(loaded);
        setFailed(!loaded);
      },
      (error) => {
        console.error('Could not read the push keys:', error);
        if (current) setFailed(true);
      }
    );
    return () => {
      current = false;
    };
  }, [uid, ready]);

  return { keys, failed };
}
