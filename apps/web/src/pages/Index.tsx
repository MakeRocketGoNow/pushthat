import {
  BellAlertIcon,
  BoltIcon,
  CodeBracketIcon,
  DevicePhoneMobileIcon,
  DocumentArrowUpIcon,
  KeyIcon,
  LockClosedIcon,
  MagnifyingGlassIcon,
  ShieldCheckIcon,
} from '@heroicons/react/24/outline';
import clsx from 'clsx';
import { Helmet } from 'react-helmet';
import { Link } from 'react-router';

import { GlowLink } from '@/components/GlowLink';
import { LIMITS, PRO_PRICE_USD, REFUND_DAYS, formatMb } from '@/config/plan';

import styles from './Index.module.css';

/** The public repository: the footer and the encryption section point readers at the code and the design. */
const SOURCE_URL = 'https://github.com/MakeRocketGoNow/pushthat';
const E2EE_SPEC_URL = `${SOURCE_URL}/blob/main/docs/e2ee.md`;

/**
 * Keeps the one-sentence pitch in one place: Helmet's description repeats it so a search
 * result and a shared link say what the hero says. index.html carries the same text as
 * static Open Graph tags for crawlers that do not run the app.
 */
const DESCRIPTION =
  'Share a link or a file from your phone and it arrives on your computer. Push from the browser and your phone ' +
  'buzzes. End-to-end encrypted with the password you already have. Free to start.';

/**
 * The hero's picture: the Android share sheet feeding a tab on the desktop, with an
 * encrypted "pill" traveling between them. The screenshots are the real apps; the pill
 * is the one thing drawn, because the point it makes (what travels is ciphertext) is
 * not something a screenshot can show.
 */
function HeroVisual() {
  return (
    <div className={styles.heroVisual} aria-hidden>
      <div className={styles.browserFrame}>
        <img src="/browser_receive.png" alt="" />
      </div>
      <div className={styles.phoneFrame}>
        <img src="/android_share.png" alt="" />
      </div>
      <div className={styles.pill}>
        <LockClosedIcon className={styles.pillIcon} />
        <code>9f3a…c17e</code>
      </div>
    </div>
  );
}

function HowItWorks() {
  const steps = [
    {
      title: 'Sign in everywhere',
      body: 'One account on your phone, your computer and Chrome. Your password unlocks the key on each device, and it never leaves them.',
    },
    {
      title: 'Share it',
      body: 'Tap PushThat in the share sheet on your phone. On a computer, paste it into PushThat on the web or in the Chrome extension. A link, a page, a photo, a PDF.',
    },
    {
      title: 'It is already there',
      body: 'With the Chrome extension, a link opens in a new tab on your computer. A push from the browser arrives on your phone as a notification. Every push lands in one searchable list on every device.',
    },
  ];
  return (
    <section className={styles.section} id="how">
      <h2 className={styles.sectionTitle}>How it works</h2>
      <ol className={styles.steps}>
        {steps.map((step, i) => (
          <li key={step.title} className={styles.step}>
            <span className={styles.stepNumber}>{i + 1}</span>
            <h3>{step.title}</h3>
            <p>{step.body}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** The reverse direction, so that nobody reads the hero as "phone to computer" only. */
function BothDirections() {
  return (
    <section className={clsx(styles.section, styles.band)}>
      <div className={styles.bandText}>
        <h2 className={styles.sectionTitle}>Both directions</h2>
        <p>
          Push a page from Chrome or the web app and your phone buzzes. Open the notification and the link is there, in
          the browser you use on the phone. Found something on the phone instead? Share it, and it is a tab in Chrome
          before you have reached the keyboard.
        </p>
      </div>
      <div className={styles.bandVisual} aria-hidden>
        <div className={styles.bandBrowser}>
          <img src="/browser_share.png" alt="" />
        </div>
        <div className={styles.bandPhone}>
          <img src="/android_receive.png" alt="" />
        </div>
      </div>
    </section>
  );
}

function Encryption() {
  const points = [
    {
      Icon: KeyIcon,
      title: 'Your password is the key',
      body: 'The app turns your password into the key on the device. There is no second passphrase to set up and nothing to switch on: it is on for every push, from the first.',
    },
    {
      Icon: MagnifyingGlassIcon,
      title: 'Search without reading',
      body: 'Search runs on scrambled tokens made with your key, so the server can match a search without ever seeing the words.',
    },
    {
      Icon: ShieldCheckIcon,
      title: 'A recovery key, shown once',
      body: 'Forget your password and the recovery key keeps your history. Without it, nobody can read the old pushes, and that includes us.',
    },
  ];
  return (
    <section className={clsx(styles.section, styles.encryption)} id="encryption">
      <p className={styles.eyebrow}>End-to-end encrypted</p>
      <h2 className={styles.sectionTitle}>Encrypted before it leaves your hand.</h2>
      <p className={styles.intro}>
        A push’s link, its title, a file’s name and its contents are encrypted on your device and opened only on the
        devices you sign in to. Our servers, Google’s, and anyone with access to either hold only what they cannot read.
      </p>
      <div className={styles.cards}>
        {points.map(({ Icon, title, body }) => (
          <div key={title} className={styles.card}>
            <Icon className={styles.cardIcon} />
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>
      <p className={styles.honest}>
        <strong>What we can still see:</strong> which account pushed, when, whether it was a link or a file, roughly how
        big a file is, which of your devices sent it and how many pushes you make. Search also shows us when two of your
        pushes share a word, though not what the word is. The monthly limits, file expiry and notifications need these.
        The design is published, so you can check it rather than take our word for it.
      </p>
      <p className={styles.links}>
        <Link to="/security">The security page</Link>
        <a href={E2EE_SPEC_URL} target="_blank" rel="noreferrer">
          The specification
        </a>
      </p>
    </section>
  );
}

function Features() {
  const features = [
    {
      Icon: BoltIcon,
      title: 'Opens before you get there',
      body: 'The Chrome extension opens a pushed link in a new tab the moment it arrives. No click, and no site tab left open to do it.',
    },
    {
      Icon: BellAlertIcon,
      title: 'Your phone, from the browser',
      body: 'Push a page from Chrome or the web app and it arrives on your phone as a notification that opens the link.',
    },
    {
      Icon: DocumentArrowUpIcon,
      title: 'Files too',
      body: `Photos, PDFs, anything up to ${formatMb(LIMITS.pro.fileBytes)}. Stored under a random name, encrypted like everything else, and gone when they expire.`,
    },
    {
      Icon: MagnifyingGlassIcon,
      title: 'One list, searchable',
      body: 'Everything you have pushed, on every device, with search. Links stay until you delete them.',
    },
    {
      Icon: DevicePhoneMobileIcon,
      title: 'Every device you own',
      body: 'Android, iPhone, Mac, the web, and a Chrome extension. The same account and the same list on all of them.',
    },
    {
      Icon: CodeBracketIcon,
      title: 'Source available',
      body: 'The apps, the rules that guard the database and the encryption design are public. Read them, build them, or run your own.',
    },
  ];
  return (
    <section className={styles.section} id="features">
      <h2 className={styles.sectionTitle}>What it does</h2>
      <div className={styles.cards}>
        {features.map(({ Icon, title, body }) => (
          <div key={title} className={styles.card}>
            <Icon className={styles.cardIcon} />
            <h3>{title}</h3>
            <p>{body}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

/** The two tiers side by side (docs/billing.md at the repository root). The numbers are the functions' and the rules'. */
function Pricing() {
  return (
    <section className={clsx(styles.section, styles.pricing)} id="pricing">
      <h2 className={styles.sectionTitle}>Pricing</h2>
      <p className={styles.intro}>Free is enough for a link or two most days. Pro is for people who live in it.</p>
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
          <GlowLink to="/login" className={styles.tierCta}>
            Sign up free
          </GlowLink>
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
          <GlowLink to="/login" className={styles.tierCta} variant="solid">
            Sign up, then upgrade
          </GlowLink>
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
      <Helmet>
        <title>PushThat: send links and files between your devices, encrypted</title>
        <meta name="description" content={DESCRIPTION} />
      </Helmet>

      <header className={styles.hero}>
        <div className={styles.heroText}>
          <p className={styles.eyebrow}>
            <LockClosedIcon className={styles.eyebrowIcon} />
            End-to-end encrypted. Source available.
          </p>
          <h1 className={styles.title}>Send a link to your phone. Or from it.</h1>
          <p className={styles.subtitle}>
            PushThat moves links and files between your phone and your computer. Share from Android or iPhone and it
            opens in Chrome before you reach the keyboard, and waits in the list on the web and on your Mac. Everything
            is encrypted on the device with the password you already have, so nobody in between can read it. Including
            us.
          </p>
          <div className={styles.ctaRow}>
            <GlowLink to="/login" variant="solid">
              Get started free
            </GlowLink>
            <a className={styles.ctaSecondary} href="#encryption">
              How it’s encrypted
            </a>
          </div>
          <p className={styles.finePrint}>Free plan, no card. Android, iPhone, Mac, the web and Chrome.</p>
        </div>
        <HeroVisual />
      </header>

      <HowItWorks />
      <BothDirections />
      <Encryption />
      <Features />
      <Pricing />

      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerBrand}>
            <img src="/pushthat.svg" alt="" width={20} height={20} />© {new Date().getFullYear()} PushThat
          </span>
          <nav className={styles.footerNav}>
            <Link to="/support">Support</Link>
            <Link to="/security">Security</Link>
            <Link to="/privacy">Privacy</Link>
            <Link to="/terms">Terms</Link>
            <a href={SOURCE_URL} target="_blank" rel="noreferrer">
              Source
            </a>
          </nav>
        </div>
      </footer>
    </div>
  );
}
