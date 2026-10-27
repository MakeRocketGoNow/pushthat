import { useEffect, useRef, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link, useNavigate, useSearchParams } from 'react-router';

import Button from '@/components/Button';
import { LIMITS, formatMb } from '@/config/plan';
import { usePlan } from '@/hooks/usePlan';
import { deviceId } from '@/services/keyStore';
import { PlanReport, errorText, planApi } from '@/services/plan';

import styles from './Plan.module.css';

/** How often, and how many times, the plan is read back from Stripe after a checkout; see `settleCheckout`. */
const CHECKOUT_SETTLE_WAIT_MS = 1500;
const CHECKOUT_SETTLE_TRIES = 6;

/** Where the browser is sent for the checkout and the portal. A seam for tests, which cannot leave the page. */
export const leavePage = { to: (url: string) => window.location.assign(url) };

const formatDay = (iso: string) =>
  new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });

/**
 * Where the account stands, as a title and a sentence. One function so the states
 * cannot drift: Free, subscribed, cancelling, payment failed, complimentary.
 */
export function describePlan(plan: PlanReport): { title: string; sentence: string } {
  const sub = plan.subscription;
  // A comp is complimentary while it runs; one that has ended is a Free account whose
  // Pro ended on a date, like a lapsed subscription (`type` stays `comp` either way).
  if (sub?.type === 'comp' && plan.tier === 'pro') {
    return {
      title: 'Pro, complimentary',
      sentence: sub.expiresAt ? `On the house until ${formatDay(sub.expiresAt)}.` : 'On the house, with no end date.',
    };
  }
  if (sub?.status === 'past_due' || sub?.status === 'unpaid') {
    return {
      title: plan.tier === 'pro' ? 'Payment failed' : 'Free',
      sentence:
        plan.tier === 'pro'
          ? `The last renewal could not be collected. Stripe will try again; update the card to keep Pro${sub.expiresAt ? ` past ${formatDay(sub.expiresAt)}` : ''}.`
          : 'The last renewal could not be collected, so the account is back on Free. Update the card to be Pro again.',
    };
  }
  if (plan.tier === 'free') {
    return {
      title: 'Free',
      sentence: sub?.expiresAt
        ? `Pro ended on ${formatDay(sub.expiresAt)}. Subscribe to get it back.`
        : 'Subscribe for more pushes, bigger files and longer retention.',
    };
  }
  if (sub?.cancelsAt) {
    return {
      title: 'Pro, cancelling',
      sentence: `Pro ends on ${formatDay(sub.cancelsAt)}. The account goes back to Free then.`,
    };
  }
  return { title: 'Pro', sentence: sub?.expiresAt ? `Renews on ${formatDay(sub.expiresAt)}.` : 'Active.' };
}

/**
 * The account's plan: where it stands, this month's usage against its limits, and the
 * two things that change it: subscribing, and managing the subscription in Stripe's
 * portal. The checkout is Stripe's own page, reached by redirect from a session the
 * server made; Stripe sends the person back here with `?checkout=complete` once paid,
 * and the plan is then read back from Stripe at once rather than waiting on the
 * webhook, so the page says "Pro" on arrival.
 *
 * Not linked from the navigation until launch (`PLAN_PAGE_LINKED`): production runs on
 * the Stripe sandbox's keys until then, and a test card here would give anyone Pro.
 */
export default function Plan() {
  const { plan, error: readError, refresh, setPlan } = usePlan();
  const [busy, setBusy] = useState<'checkout' | 'settling' | 'portal' | 'payment' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const settled = useRef(false);
  // The one listener waiting for a return from the portal, so a second press replaces
  // it rather than adding another, and leaving the page removes it.
  const onReturn = useRef<(() => void) | null>(null);
  useEffect(
    () => () => {
      if (onReturn.current) document.removeEventListener('visibilitychange', onReturn.current);
    },
    []
  );

  // Back from a paid checkout: read the plan until it names the subscription, then say
  // so, and take the query off the address so a reload does not read it back again.
  useEffect(() => {
    if (settled.current || params.get('checkout') !== 'complete') return;
    settled.current = true;
    void navigate('/plan', { replace: true });
    setBusy('settling');
    void settleCheckout()
      .then((found) =>
        setNotice(found ? 'You’re on Pro. Thank you.' : 'Your plan will update once Stripe confirms the payment.')
      )
      .finally(() => setBusy(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  // The browser's Back can restore this page from its cache with the button still busy.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setBusy(null);
    };
    window.addEventListener('pageshow', onShow);
    return () => window.removeEventListener('pageshow', onShow);
  }, []);

  async function readBack(): Promise<PlanReport | undefined> {
    const read = await planApi.refreshSubscription().catch(() => undefined);
    if (read) setPlan(read);
    return read;
  }

  /** Reads the plan back from Stripe until it is Pro, a few times over a few seconds; the webhook settles anything slower. */
  async function settleCheckout(): Promise<boolean> {
    for (let attempt = 0; attempt < CHECKOUT_SETTLE_TRIES; attempt++) {
      const read = await readBack();
      if (read?.tier === 'pro') return true;
      await new Promise((r) => setTimeout(r, CHECKOUT_SETTLE_WAIT_MS));
    }
    return false;
  }

  /** To Stripe's checkout page. The button stays busy until the browser has left. */
  async function subscribe() {
    setBusy('checkout');
    setError(null);
    try {
      const { url } = await planApi.createCheckoutSession();
      leavePage.to(url);
    } catch (err) {
      setError(errorText(err, 'The checkout could not be opened.'));
      setBusy(null);
    }
  }

  /**
   * The portal opens in a new tab, opened before the link is fetched: a `window.open`
   * after an `await` is a pop-up to the browser. What was done there is read back when
   * this tab is next looked at, since the webhook may or may not have landed by then.
   */
  async function openPortal(flow?: 'payment') {
    setBusy(flow ?? 'portal');
    setError(null);
    const tab = window.open('', '_blank');
    // Opened blank, so `noopener` cannot be asked for (it makes `window.open` answer null);
    // the opener is cut by hand so Stripe's page cannot reach this one.
    if (tab) tab.opener = null;
    try {
      const { url } = await planApi.createPortalSession(flow);
      if (tab) tab.location.href = url;
      else leavePage.to(url);
      if (onReturn.current) document.removeEventListener('visibilitychange', onReturn.current);
      // `readBack` already keeps the report it reads, so no second read is needed.
      const handler = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', handler);
        onReturn.current = null;
        void readBack();
      };
      onReturn.current = handler;
      document.addEventListener('visibilitychange', handler);
    } catch (err) {
      tab?.close();
      setError(errorText(err, 'The billing portal could not be opened.'));
    } finally {
      setBusy(null);
    }
  }

  if (!plan) {
    return (
      <div>
        <Helmet>
          <title>Plan</title>
        </Helmet>
        <h1>Plan</h1>
        {readError ? (
          <p className={styles.row}>
            <span className={styles.error} role="alert">
              {readError}
            </span>
            <Button outline onClick={() => void refresh()}>
              Try again
            </Button>
          </p>
        ) : (
          <p className={styles.muted}>Reading your plan…</p>
        )}
      </div>
    );
  }

  const { title, sentence } = describePlan(plan);
  const sub = plan.subscription;
  // Which buttons to draw is the server's answer (`canSubscribe` is the checkout's own
  // test, `hasCustomer` whether the portal has anything to open), so the page cannot
  // offer what the functions would refuse, or refuse what they would allow.
  const { canSubscribe, hasCustomer } = plan;
  const pastDue = sub?.status === 'past_due' || sub?.status === 'unpaid';
  const limits = plan.limits;

  return (
    <div className={styles.page}>
      <Helmet>
        <title>Plan</title>
      </Helmet>
      <h1>Plan</h1>

      <section className={styles.section}>
        <h2>{title}</h2>
        <p>{sentence}</p>
        {canSubscribe && (
          <div className={styles.row}>
            <Button solid onClick={() => void subscribe()} isSubmitting={busy !== null}>
              {busy === 'checkout'
                ? 'Opening checkout…'
                : busy === 'settling'
                  ? 'Confirming your subscription…'
                  : `Subscribe for $${plan.priceUsd} a year`}
            </Button>
            <span className={styles.muted}>Before tax, charged by Stripe. Cancel any time.</span>
          </div>
        )}
        {hasCustomer && (
          <div className={styles.row}>
            <Button outline onClick={() => void openPortal()} isSubmitting={busy !== null}>
              {busy === 'portal' ? 'Opening…' : 'Manage billing'}
            </Button>
            {pastDue && (
              <Button outline onClick={() => void openPortal('payment')} isSubmitting={busy !== null}>
                {busy === 'payment' ? 'Opening…' : 'Update payment method'}
              </Button>
            )}
            <span className={styles.muted}>
              {canSubscribe
                ? 'Past invoices, in Stripe’s billing portal.'
                : 'Invoices, the card, and cancelling, in Stripe’s billing portal.'}
            </span>
          </div>
        )}
        {error && (
          <p className={styles.error} role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className={styles.notice} role="status">
            {notice}
          </p>
        )}
      </section>

      <section className={styles.section}>
        <h2>This month</h2>
        <Meter label="URL pushes" used={plan.usage.url} limit={limits.url} />
        <Meter label="File pushes" used={plan.usage.file} limit={limits.file} />
        <p className={styles.muted}>
          Files up to {formatMb(limits.fileBytes)}, kept for {limits.keepDays} days from the moment they are pushed; a
          file already pushed keeps the retention it was pushed with. The month starts on the day you{' '}
          {plan.tier === 'pro' ? 'subscribed' : 'signed up'}.
        </p>
      </section>

      {plan.tier === 'free' && (
        <section className={styles.section}>
          <h2>Pro</h2>
          <ul className={styles.list}>
            <li>
              {LIMITS.pro.url.toLocaleString()} URL pushes a month, up from {LIMITS.free.url}
            </li>
            <li>
              {LIMITS.pro.file} file pushes a month, up from {LIMITS.free.file}
            </li>
            <li>
              Files up to {formatMb(LIMITS.pro.fileBytes)}, up from {formatMb(LIMITS.free.fileBytes)}
            </li>
            <li>
              Files kept {LIMITS.pro.keepDays} days, up from {LIMITS.free.keepDays}
            </li>
          </ul>
          <p className={styles.muted}>
            ${plan.priceUsd} a year. Refunds, cancelling and receipts are explained on the{' '}
            <Link to="/support">support page</Link>.
          </p>
        </section>
      )}

      <Encrypted />
    </div>
  );
}

/**
 * The "Encrypted" line (docs/e2ee.md, Saying so): that the pushes are encrypted, this
 * device's id, and where to read what that means. On the Plan page because the web app has
 * no settings page and this is the page about the account. The id is what this install
 * puts on its pushes in place of the device's model name, so showing it lets someone see
 * all the server is told about the device. IndexedDB can refuse (a private window in
 * some browsers), and the line then goes without the id rather than not at all.
 */
function Encrypted() {
  const [id, setId] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    deviceId()
      .then((made) => current && setId(made))
      .catch((error) => console.error('Could not read the device id:', error));
    return () => {
      current = false;
    };
  }, []);

  return (
    <section className={styles.section}>
      <h2>Encrypted</h2>
      <p>
        Your pushes are encrypted on your devices with a key made from your password, and only they can read them.{' '}
        <Link to="/security">How it works</Link>.
      </p>
      {id && (
        <p className={styles.muted}>
          This device: <code className={styles.deviceId}>{id}</code>
        </p>
      )}
    </section>
  );
}

function Meter({ label, used, limit }: { label: string; used: number; limit: number }) {
  const share = Math.min(1, used / limit);
  return (
    <div className={styles.meter}>
      <div className={styles.meterLabel}>
        <span>{label}</span>
        <span>
          {used.toLocaleString()} of {limit.toLocaleString()}
        </span>
      </div>
      <div
        className={styles.meterBar}
        role="meter"
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={used}
        aria-label={label}
      >
        <div
          className={share >= 0.95 ? styles.meterFillFull : styles.meterFill}
          style={{ width: `${Math.round(share * 100)}%` }}
        />
      </div>
    </div>
  );
}
