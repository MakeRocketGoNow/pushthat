import { useKeys } from '@/contexts/KeysContext';
import { type PushKeys } from '@/services/pushes';

/**
 * Said wherever a page needs the push keys and does not have them: they load a moment after
 * the page does, and fail to in a browser that refuses IndexedDB.
 */
export const KEYS_UNAVAILABLE = 'Your encryption key is not ready on this device. Reload the page and try again.';

/**
 * The keys this device writes and reads pushes with, once `KeyGate` has let the page in.
 * `keys` is undefined while they load; `failed` says they could not be. Loaded once in
 * `KeysProvider`, for every page.
 */
export function usePushKeys(): { keys: PushKeys | undefined; failed: boolean } {
  const { pushKeys, pushKeysFailed } = useKeys();
  return { keys: pushKeys, failed: pushKeysFailed };
}
