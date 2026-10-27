import { FirebaseError } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';

import { app, auth } from '@/config/firebase';
import { useAuth } from '@/contexts/AuthContext';
import { KeysChangedError, WrongRecoveryKeyError } from '@/services/accountKeys';
import {
  type LoadedAccountKey,
  clearAccountKey,
  confirmRecoveryKey,
  loadAccountKey,
  onAccountKeyChanged,
} from '@/services/keyStore';
import { loadPushKeys, migratePushes } from '@/services/pushes';
import * as signInService from '@/services/signIn';
import { type KeySession, type KeysResult } from '@/services/signIn';

/**
 * Where the signed-in user is with the account key, and the steps that move it. It lives
 * above the pages rather than in the sign-in page because a sign-in flips the site from
 * its unauthed frame to its authed one partway through (`Layout`), which remounts
 * whatever page started it: a recovery key held in that page's state would be gone
 * before it was shown. `KeyGate` shows the steps; the pages behind it see `ready` only.
 */
export type KeyStep =
  | { name: 'signedOut' }
  | { name: 'checking' }
  /** A sign-in, registration or unlock is deriving and writing keys. */
  | { name: 'working' }
  /** Signed in with no key on this device: an install that updated while signed in. */
  | { name: 'unlock'; error?: string }
  | { name: 'recovery'; session: KeySession; error?: string }
  | { name: 'withoutRecovery'; session: KeySession; error?: string }
  /** A new recovery key, shown once, before anything else. */
  | { name: 'recoveryKey'; recoveryKey: string }
  | { name: 'ready' };

interface KeysContextType {
  step: KeyStep;
  /** Rejects when the sign-in itself fails, for the sign-in page to say why. */
  signIn: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  unlock: (password: string) => Promise<void>;
  recover: (recoveryKey: string) => Promise<void>;
  withoutRecovery: () => void;
  backToRecovery: () => void;
  startOver: () => Promise<void>;
  savedRecoveryKey: () => Promise<void>;
}

const KeysContext = createContext<KeysContextType | undefined>(undefined);

const fromResult = (result: KeysResult): KeyStep =>
  result.kind === 'ready'
    ? { name: 'ready' }
    : result.kind === 'recoveryKey'
      ? { name: 'recoveryKey', recoveryKey: result.recoveryKey }
      : { name: 'recovery', session: result.session };

const SIGN_IN_AGAIN = 'Enter your password again to finish.';
// What a stored key means on load: ready, or a recovery key still waiting for "I saved it".
const stepFor = (stored: LoadedAccountKey | undefined): KeyStep =>
  !stored
    ? { name: 'unlock' }
    : stored.recoveryKey
      ? { name: 'recoveryKey', recoveryKey: stored.recoveryKey }
      : { name: 'ready' };

// A ready key whose version cannot be known (pushes.ts, loadPushKeys: one saved before keys
// carried their version, on an account a reset has moved past version 1) asks for the
// password like a missing one, whose sign-in stores the key with its version.
const checkedStepFor = async (uid: string, stored: LoadedAccountKey | undefined): Promise<KeyStep> => {
  const step = stepFor(stored);
  if (step.name !== 'ready' || stored?.keyVersion !== undefined) return step;
  return (await loadPushKeys(getFirestore(app), uid)) ? step : { name: 'unlock' };
};

const KEYS_CHANGED = 'Your keys were changed on another device. Enter your password again.';

// `updatePassword`, which a legacy account's last step calls, wants a recent sign-in, and
// finding a recovery key (or deciding it is lost) can take longer than Firebase allows.
// Signing in again runs every step afresh, so that is what the user is asked to do.
const needsSignInAgain = (error: unknown) =>
  error instanceof FirebaseError && error.code === 'auth/requires-recent-login';

export function KeysProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [step, setStep] = useState<KeyStep>({ name: 'checking' });
  // Set while a flow runs. A sign-in changes the auth state partway through, and the
  // check below would otherwise find no key yet and show the unlock form over it.
  const flowing = useRef(false);
  const uid = user?.uid;

  useEffect(() => {
    if (flowing.current) return;
    if (!uid) {
      setStep({ name: 'signedOut' });
      // A key outlives its session only until here, whether the sign-out was this tab's
      // Logout, another tab's, or an expired session.
      clearAccountKey().catch((error) => console.error('Could not clear the account key:', error));
      return;
    }
    let current = true;
    setStep({ name: 'checking' });
    loadAccountKey(uid)
      .then((key) => checkedStepFor(uid, key))
      .then(
        (next) => {
          if (current && !flowing.current) setStep(next);
        },
        (error) => {
          console.error('Could not read the account key:', error);
          if (current && !flowing.current) setStep({ name: 'unlock' });
        }
      );
    return () => {
      current = false;
    };
  }, [uid]);

  // Once this device holds the key, the account's plaintext pushes are encrypted in place
  // (docs/e2ee.md, Migration), in the background and once per account per page load: a
  // pass cut short leaves the mark unset and the next load carries on. Here rather than in
  // a page, so it runs whichever page the user lands on.
  const migrated = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (step.name !== 'ready' || !uid || migrated.current === uid) return;
    migrated.current = uid;
    const db = getFirestore(app);
    loadPushKeys(db, uid)
      .then((keys) => keys && migratePushes(db, keys))
      .catch((error) => console.error('The push migration stopped:', error));
  }, [step.name, uid]);

  // Another tab stored the key this tab is asking the password for: take it. Only from
  // the password prompt; the other steps are in the middle of something of their own,
  // and a sign-out reaches every tab through the auth state.
  useEffect(() => {
    if (!uid || step.name !== 'unlock') return;
    return onAccountKeyChanged(() => {
      if (flowing.current) return;
      loadAccountKey(uid).then(
        async (stored) => {
          const next = stored && (await checkedStepFor(uid, stored));
          if (next && !flowing.current) setStep(next);
        },
        (error) => console.error('Could not read the account key:', error)
      );
    });
  }, [uid, step.name]);

  // A sign-in, a registration or an unlock: anything that may sign in partway through.
  const flow = useCallback(async (action: () => Promise<KeysResult>, signedInAlready: boolean) => {
    flowing.current = true;
    setStep({ name: 'working' });
    try {
      setStep(fromResult(await action()));
    } catch (error) {
      console.error('Setting up the keys failed:', error);
      if (auth.currentUser) {
        // Signed in, but the keys are not done: the unlock form runs it all again, and a
        // legacy account still has the password it signed in with.
        setStep({
          name: 'unlock',
          error:
            signedInAlready && error instanceof signInService.WrongPasswordError
              ? 'That password is not right.'
              : 'Your keys could not be set up. Try again.',
        });
      } else {
        setStep({ name: 'signedOut' });
      }
      if (!signedInAlready) throw error;
    } finally {
      flowing.current = false;
      // A sign-out while the flow ran (Logout in another tab) was skipped by the check
      // above, and the flow may have stored a key after it; nothing else would clear it.
      if (!auth.currentUser) {
        setStep({ name: 'signedOut' });
        clearAccountKey().catch((error) => console.error('Could not clear the account key:', error));
      }
    }
  }, []);

  const signIn = useCallback(
    (email: string, password: string) => flow(() => signInService.signIn(email, password), false),
    [flow]
  );
  const register = useCallback(
    (email: string, password: string) => flow(() => signInService.register(email, password), false),
    [flow]
  );
  const unlock = useCallback(
    (password: string) => {
      if (!user?.email) return Promise.reject(new Error('this account has no email'));
      return flow(() => signInService.signIn(user.email!, password), true);
    },
    [flow, user]
  );

  const recover = useCallback(
    async (recoveryKey: string) => {
      if (step.name !== 'recovery') return;
      const { session } = step;
      try {
        setStep(fromResult(await signInService.recover(session, recoveryKey)));
      } catch (error) {
        console.error('Opening the keys with the recovery key failed:', error);
        if (error instanceof KeysChangedError) setStep({ name: 'unlock', error: KEYS_CHANGED });
        else if (needsSignInAgain(error)) setStep({ name: 'unlock', error: SIGN_IN_AGAIN });
        else
          setStep({
            name: 'recovery',
            session,
            error:
              error instanceof WrongRecoveryKeyError
                ? "That recovery key does not open this account's keys."
                : 'Your keys could not be saved. Try again.',
          });
      }
    },
    [step]
  );

  const startOver = useCallback(async () => {
    if (step.name !== 'withoutRecovery') return;
    const { session } = step;
    try {
      setStep(fromResult(await signInService.startOver(session)));
    } catch (error) {
      console.error('Starting new keys failed:', error);
      setStep(
        error instanceof KeysChangedError
          ? { name: 'unlock', error: KEYS_CHANGED }
          : needsSignInAgain(error)
            ? { name: 'unlock', error: SIGN_IN_AGAIN }
            : { name: 'withoutRecovery', session, error: 'Your new keys could not be saved. Try again.' }
      );
    }
  }, [step]);

  const withoutRecovery = useCallback(() => {
    if (step.name === 'recovery') setStep({ name: 'withoutRecovery', session: step.session });
  }, [step]);
  const backToRecovery = useCallback(() => {
    if (step.name === 'withoutRecovery') setStep({ name: 'recovery', session: step.session });
  }, [step]);
  const savedRecoveryKey = useCallback(async () => {
    if (!uid) return;
    try {
      await confirmRecoveryKey(uid);
      // Read back rather than assumed: if the key could not be stored, this is the
      // password prompt.
      const stored = await loadAccountKey(uid);
      setStep(stored ? { name: 'ready' } : { name: 'unlock' });
    } catch (error) {
      console.error('Could not confirm the recovery key:', error);
      setStep({ name: 'unlock', error: 'Your keys could not be set up. Try again.' });
    }
  }, [uid]);

  return (
    <KeysContext.Provider
      value={{ step, signIn, register, unlock, recover, withoutRecovery, backToRecovery, startOver, savedRecoveryKey }}
    >
      {children}
    </KeysContext.Provider>
  );
}

export function useKeys(): KeysContextType {
  const context = useContext(KeysContext);
  if (!context) throw new Error('useKeys outside KeysProvider');
  return context;
}
