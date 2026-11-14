import { useEffect, useState } from 'react';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router';

import { PLAN_PAGE_LINKED } from '@/config/plan';
import { useAuth } from '@/contexts/AuthContext';
import { usePlan } from '@/hooks/usePlan';
import { deviceId } from '@/services/keyStore';

import { describePlan } from './Plan';

import styles from './Account.module.css';

/**
 * Account, `/account`: the menu's way into everything about the account. Who is signed
 * in, the plan in a line with the way to its own page, the "Encrypted" line, and the way
 * to delete the account.
 *
 * One page with links out, rather than a settings layout with the plan and deletion as
 * tabs inside it, because neither of those can move: `/delete-account` is public (it is the
 * address given to Google Play, read by people with no account) and `/plan` is where
 * Stripe's checkout and portal send people back to. A settings layout would have had to
 * leave itself for both.
 */
export function Account() {
  const { user } = useAuth();

  return (
    <div className={styles.page}>
      <Helmet>
        <title>Account</title>
      </Helmet>
      <h1>Account</h1>

      <section className={styles.section}>
        <h2>Email</h2>
        <p className={styles.email}>{user?.email}</p>
      </section>

      {PLAN_PAGE_LINKED && <PlanSummary />}

      <Encrypted />

      <section className={styles.section}>
        <h2>Delete account</h2>
        <p>
          Deletes the account and everything pushed from it, at once and for good. The next page says exactly what goes
          and asks for your password first.
        </p>
        <p>
          <Link to="/delete-account" className={styles.danger}>
            Delete account
          </Link>
        </p>
      </section>
    </div>
  );
}

/** The plan as the Plan page heads it, in one line. The usage and the billing stay on that page. */
function PlanSummary() {
  const { plan, error } = usePlan();
  const summary = plan && describePlan(plan);

  return (
    <section className={styles.section}>
      <h2>Plan</h2>
      {summary ? (
        <p>
          <strong>{summary.title}.</strong> {summary.sentence}
        </p>
      ) : error ? (
        <p className={styles.error} role="alert">
          {error}
        </p>
      ) : (
        <p className={styles.muted}>Reading your plan…</p>
      )}
      <p>
        <Link to="/plan">Usage and billing</Link>
      </p>
    </section>
  );
}

/**
 * The "Encrypted" line (docs/e2ee.md, Saying so): that the pushes are encrypted, this
 * device's id, and where to read what that means. The id is what this install puts on its
 * pushes in place of the device's model name, so showing it lets someone see all the
 * server is told about the device. IndexedDB can refuse (a private window in some
 * browsers), and the line then goes without the id rather than not at all.
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
