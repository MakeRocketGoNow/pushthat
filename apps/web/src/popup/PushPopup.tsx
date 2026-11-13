import { useEffect, useState } from 'react';

import Button from '@/components/Button';
import {
  NOT_A_WEB_PAGE_MESSAGE,
  type Page,
  PagePushError,
  type PagePushFailure,
  pageOfTab,
  pushPage,
} from '@/services/pagePush';

import styles from './PushPopup.module.css';

/** The list's placeholder, drawn here for a page without an icon, as the list will draw it. */
const PLACEHOLDER = '/pushthat-mono.svg';

// Long enough to read "Pushed", short enough not to be in the way of the page.
const CLOSE_AFTER_PUSH_MS = 900;

type State =
  | { kind: 'reading' }
  | { kind: 'unpushable' }
  | { kind: 'ready'; page: Page }
  | { kind: 'pushing'; page: Page }
  | { kind: 'pushed'; page: Page }
  | { kind: 'failed'; page: Page; message: string; reason: PagePushFailure };

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
      if (!cancelled) setState(page ? { kind: 'ready', page } : { kind: 'unpushable' });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const push = async (page: Page) => {
    setState({ kind: 'pushing', page });
    try {
      await pushPage(page);
      setState({ kind: 'pushed', page });
      setTimeout(() => window.close(), CLOSE_AFTER_PUSH_MS);
    } catch (error) {
      // `pushPage` throws nothing but a `PagePushError`.
      const failure = error as PagePushError;
      setState({ kind: 'failed', page, message: failure.message, reason: failure.reason });
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
        <img className={styles.icon} src={page.icon ? `data:image/png;base64,${page.icon}` : PLACEHOLDER} alt="" />
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
        <Button solid onClick={() => void openApp()}>
          {state.reason === 'signIn' ? 'Sign in' : 'Check your pushes'}
        </Button>
      ) : state.kind === 'pushed' ? (
        <p className={styles.done} role="status">
          Pushed
        </p>
      ) : (
        // `autoFocus`, which React applies when the button mounts, after the tab is read, so
        // Enter pushes. The same button stays through pushing and a retry.
        <Button autoFocus solid isSubmitting={state.kind === 'pushing'} onClick={() => void push(page)}>
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
