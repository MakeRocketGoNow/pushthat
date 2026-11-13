import { useEffect, useState } from 'react';

import Button from '@/components/Button';
import { auth } from '@/config/firebase';
import { PLACEHOLDER_ICON } from '@/services/pageIcon';
import {
  NOT_A_WEB_PAGE_MESSAGE,
  PUSH_PORT,
  type Page,
  type PagePushFailure,
  type PushReply,
  type PushRequest,
  SIGNED_OUT_MESSAGE,
  pageOfTab,
} from '@/services/pagePush';
import { UNCONFIRMED_MESSAGE } from '@/services/pushRefusal';

import styles from './PushPopup.module.css';

// Long enough to read "Pushed", short enough not to be in the way of the page.
const CLOSE_AFTER_PUSH_MS = 900;

type State =
  | { kind: 'reading' }
  | { kind: 'unpushable' }
  | { kind: 'ready'; page: Page }
  | { kind: 'pushing'; page: Page }
  | { kind: 'pushed'; page: Page }
  | { kind: 'failed'; page: Page; message: string; reason: PagePushFailure };

/**
 * Hands `page` to the service worker to push (`PUSH_PORT`) and waits for its answer. A port
 * that closes with no answer means the worker stopped mid-push, after which nobody can say
 * whether it landed.
 */
const pushThroughWorker = (page: Page) =>
  new Promise<PushReply>((resolve) => {
    const port = chrome.runtime.connect({ name: PUSH_PORT });
    port.onMessage.addListener((reply: PushReply) => {
      resolve(reply);
      port.disconnect();
    });
    port.onDisconnect.addListener(() => resolve({ ok: false, message: UNCONFIRMED_MESSAGE, reason: 'unconfirmed' }));
    port.postMessage({ page } satisfies PushRequest);
  });

const openApp = async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL('index.html') });
  window.close();
};

/**
 * The toolbar button's popup: the tab you are on, as it will be pushed, with a button to
 * push it and a link to the full app, which is what the toolbar button opened before it had
 * a popup. Not a push on open: a click that only meant to reach the list would otherwise
 * send a push nobody wanted, and the button is focused, so Enter pushes.
 */
export function PushPopup() {
  const [state, setState] = useState<State>({ kind: 'reading' });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const page = tab ? await pageOfTab(tab) : undefined;
      // Signed out is known here at once, from the session Firebase keeps in this browser,
      // so the popup offers "Sign in" from the start rather than a push that is bound to be
      // refused. A missing key is left to the push: telling needs the key store and
      // possibly Firestore, a wait on every open for a case that is rare.
      await auth.authStateReady();
      if (cancelled) return;
      if (!page) setState({ kind: 'unpushable' });
      else if (!auth.currentUser) setState({ kind: 'failed', page, message: SIGNED_OUT_MESSAGE, reason: 'signIn' });
      else setState({ kind: 'ready', page });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const push = async (page: Page) => {
    setState({ kind: 'pushing', page });
    const reply = await pushThroughWorker(page);
    if (reply.ok) {
      setState({ kind: 'pushed', page });
      setTimeout(() => window.close(), CLOSE_AFTER_PUSH_MS);
    } else {
      setState({ kind: 'failed', page, message: reply.message, reason: reply.reason });
    }
  };

  if (state.kind === 'reading') return <div className={styles.popup} aria-busy="true" />;

  if (state.kind === 'unpushable') {
    return (
      <div className={styles.popup}>
        <p className={styles.note}>{NOT_A_WEB_PAGE_MESSAGE}</p>
        <OpenApp />
      </div>
    );
  }

  const { page } = state;
  return (
    <div className={styles.popup}>
      <div className={styles.page}>
        <img className={styles.icon} src={page.icon ? `data:image/png;base64,${page.icon}` : PLACEHOLDER_ICON} alt="" />
        <div className={styles.text}>
          <div className={styles.title}>{page.title || new URL(page.url).host}</div>
          <div className={styles.url}>{page.url}</div>
        </div>
      </div>

      {state.kind === 'failed' && (
        <p className={styles.error} role="alert">
          {state.message}
        </p>
      )}

      {state.kind === 'failed' && state.reason !== 'other' ? (
        // Both are the app: to sign in, or to see whether the push landed. Never a retry for
        // an unconfirmed push, which could make it twice.
        <Button autoFocus solid onClick={() => void openApp()}>
          {state.reason === 'signIn' ? 'Sign in' : 'Check your pushes'}
        </Button>
      ) : state.kind === 'pushed' ? (
        <p className={styles.done} role="status">
          Pushed
        </p>
      ) : (
        // `autoFocus`, which React applies when the button mounts, after the tab is read, so
        // Enter pushes. Disabled while pushing, the button loses focus, so a failure mounts it
        // again (`key`) and Enter tries again.
        <Button
          key={state.kind === 'failed' ? 'retry' : 'push'}
          autoFocus
          solid
          isSubmitting={state.kind === 'pushing'}
          onClick={() => void push(page)}
        >
          {state.kind === 'pushing' ? 'Pushing…' : state.kind === 'failed' ? 'Try again' : 'Push this page'}
        </Button>
      )}

      {/* Opening the app is what the button above already does. */}
      {!(state.kind === 'failed' && state.reason !== 'other') && <OpenApp />}
    </div>
  );
}

function OpenApp() {
  return (
    <button type="button" className={styles.openApp} onClick={() => void openApp()}>
      Open PushThat
    </button>
  );
}
