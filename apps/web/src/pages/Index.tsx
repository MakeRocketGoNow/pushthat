import { Link } from 'react-router';

import styles from './Index.module.css';
import { GlowLink } from '@/components/GlowLink';
import { LIMITS, PRO_PRICE_USD, REFUND_DAYS, formatMb } from '@/config/plan';
import clsx from 'clsx';

/** The two tiers side by side (docs/billing.md in pushthat-functions). The numbers are the functions' and the rules'. */
function Pricing() {
  return (
    <section className={styles.pricing} id="pricing">
      <h2 className={styles.pricingTitle}>Pricing</h2>
      <div className={styles.tiers}>
        <div className={styles.tier}>
          <h3>Free</h3>
          <p className={styles.price}>$0</p>
          <ul>
            <li>{LIMITS.free.url} links a month</li>
            <li>{LIMITS.free.file} files a month</li>
            <li>Files up to {formatMb(LIMITS.free.fileBytes)}</li>
            <li>Files kept {LIMITS.free.keepDays} days</li>
          </ul>
        </div>
        <div className={clsx(styles.tier, styles.tierPro)}>
          <h3>Pro</h3>
          <p className={styles.price}>
            ${PRO_PRICE_USD} <span className={styles.priceNote}>a year, before tax</span>
          </p>
          <ul>
            <li>{LIMITS.pro.url.toLocaleString()} links a month</li>
            <li>{LIMITS.pro.file} files a month</li>
            <li>Files up to {formatMb(LIMITS.pro.fileBytes)}</li>
            <li>Files kept {LIMITS.pro.keepDays} days</li>
          </ul>
        </div>
      </div>
      <p className={styles.pricingNote}>
        Links are kept until you delete them. Every account starts on Free; Pro is a subscription managed in the web
        app, and any charge is refunded in full within {REFUND_DAYS} days if you ask.
      </p>
    </section>
  );
}

export function IndexPage() {
  return (
    <div className={styles.container}>
      <header className={styles.hero}>
        <img className={styles.logo} src="/pushthat.svg" alt="PushThat logo" />
        <h1 className={styles.title}>PushThat</h1>
        <p className={styles.subtitle}>The easiest way to send links and files between Android and your other devices.</p>
        <div className={styles.ctaRow}>
          {/* <a className={styles.ctaButton} href="https://chromewebstore.google.com/" target="_blank" rel="noreferrer">
            Add Chrome Extension
          </a> */}
          <GlowLink to="/login" style={{ minWidth: '200px' }} variant="solid">
            Signup for free
          </GlowLink>
        </div>
      </header>

      <section className={styles.row}>
        <div className={clsx(styles.panel, styles.panelLeft)}>
          <img className={styles.screenshot} src="/android_share.png" alt="Share from Android" />
        </div>

        <div className={styles.arrow} aria-hidden>
          <span>Android to Desktop</span>
          <svg viewBox="0 0 120 24" xmlns="http://www.w3.org/2000/svg" className={styles.arrowSvg}>
            <path d="M0 12h100" className={styles.arrowLine} />
            <path d="M100 4l16 8-16 8" className={styles.arrowHead} />
          </svg>
        </div>

        <div className={`${styles.panel}`}>
          <img className={styles.screenshot} src="/browser_receive.png" alt="Receive on desktop browser" />
        </div>
      </section>

      <section className={`${styles.row}`}>
        <div className={clsx(styles.panel, styles.panelLeft)}>
          <img className={styles.screenshot} src="/android_receive.png" alt="Receive on Android (notification)" />
        </div>

        <div className={styles.arrow} aria-hidden>
          <span>Desktop to Android</span>
          <svg viewBox="0 0 120 24" xmlns="http://www.w3.org/2000/svg" className={styles.arrowSvg}>
            <path d="M120 12H20" className={styles.arrowLine} />
            <path d="M20 4L4 12L20 20" className={styles.arrowHead} />
          </svg>
        </div>

        <div className={`${styles.panel}`}>
          <img className={styles.screenshot} src="/browser_share.png" alt="Share from desktop browser" />
        </div>
      </section>

      <Pricing />

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span>© {new Date().getFullYear()} PushThat</span>
          <nav className={styles.footerNav}>
            <Link to="/support">Support</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}


