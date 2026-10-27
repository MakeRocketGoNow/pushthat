import { Helmet } from 'react-helmet';
import { Link } from 'react-router';

import LegalContainer from '@/components/LegalContainer';
import { LIMITS, SUPPORT_EMAIL } from '@/config/plan';
import { MIN_PASSWORD_LENGTH } from '@/services/signIn';

/**
 * Security, `/security`: the gist of docs/e2ee.md for the people it protects. What is
 * encrypted, what is not, what a lost password costs, and the recovery key. Public, like
 * Support, since the front page and Support link here and the reader may not have an
 * account yet; the Plan page links here too.
 *
 * It says what is not protected as plainly as what is: the reason for a key made from the
 * password is that the user can see what it does, and a page that only listed the
 * protections would be the opposite of that. When the design changes, docs/e2ee.md
 * changes first and this page follows it.
 */
export function Security() {
  return (
    <LegalContainer>
      <Helmet>
        <title>Security</title>
      </Helmet>

      <h1>Security</h1>

      <p>
        Your pushes are end-to-end encrypted. A link, its title, and a file&rsquo;s name and contents are encrypted on
        your device before they leave it, and are opened only on the devices you sign in to. Our servers, Google&rsquo;s
        (which run them), and anyone with access to either hold only what they cannot read.
      </p>

      <h5>YOUR PASSWORD IS THE KEY</h5>

      <p>
        When you sign in, the app turns your password into two keys on the device: one signs you in, and the other
        unlocks the key your pushes are encrypted with. That second key never leaves the device, so we cannot read your
        pushes. It also means we cannot reset your password for you and keep your pushes: only the recovery key, below,
        can do that. Your password reaches Google&rsquo;s sign-in service in two cases only: when you reset it, since
        the reset is made on Google&rsquo;s own page, and when a sign-in with the first key is refused (a mistyped
        password, say), since the app then tries the password itself in case the account was made before encryption.
        After a reset, your next sign-in replaces it with the key.
      </p>

      <p>
        A key is only as strong as the password it comes from. Making it is deliberately slow, about a second on a
        phone, and every guess at your password costs an attacker the same; a short or common password is still guessed
        in the end. That is why PushThat asks for at least {MIN_PASSWORD_LENGTH} characters.
      </p>

      <h5>WHAT IS ENCRYPTED</h5>

      <ul>
        <li>The link you push, and the title of its page.</li>
        <li>A file&rsquo;s name, its type and its contents. Files are stored under a random name.</li>
        <li>
          The words search looks for. Search uses scrambled tokens made with your key, so the server can match a search
          without reading the words.
        </li>
      </ul>

      <p>
        Notifications carry none of it. A device that receives one fetches the push and decrypts it itself before
        showing anything.
      </p>

      <h5>WHAT IS NOT</h5>

      <ul>
        <li>
          <strong>When and how much.</strong> Which account pushed, when, whether it was a link or a file, roughly how
          large a file is, which of your devices sent it and how many pushes you make. The monthly limits, file expiry
          and notifications need these.
        </li>
        <li>
          <strong>Search patterns.</strong> The server can tell that two of your pushes share a word, or the start of
          one, without knowing what the word is.
        </li>
        <li>
          <strong>The apps.</strong> We make the apps, and a changed app could send your key anywhere. This is true of
          every end-to-end encrypted app that updates itself: the servers cannot read your pushes, and the apps you
          install from us are what you trust.
        </li>
        <li>
          <strong>Pushes made before encryption.</strong> A link pushed before your apps updated, and its title, stay as
          they were sent until an updated app signs in to your account and encrypts them in place, which it does on its
          own. A file pushed before then was stored as it was sent, under its own name, and stays that way until it
          expires, within {LIMITS.pro.keepDays} days.
        </li>
        <li>
          <strong>An unlocked device.</strong> The key is kept in the device&rsquo;s secure storage, where the app can
          use it, so a device that is unlocked and in someone else&rsquo;s hands shows them what it shows you.
        </li>
      </ul>

      <h5>THE RECOVERY KEY</h5>

      <p>
        When your account&rsquo;s encryption is set up (when you create your account, or the first time an updated app
        signs in to an account made before encryption), PushThat shows a recovery key once: 32 letters and numbers in
        groups of four. It is a second way to unlock your pushes, and the only one besides your password. Keep it
        somewhere safe and apart from your devices, such as a password manager or on paper.
      </p>

      <p>
        If you lose it while you are still signed in, the Android, iPhone and Mac apps can show you a new one from their
        menu. The new one replaces the old, which stops working.
      </p>

      <h5>IF YOU FORGET YOUR PASSWORD</h5>

      <p>
        Reset it from the <Link to="/login">sign-in page</Link>, with the link we email you. After you choose a new
        password, you are asked for your recovery key. With it, nothing is lost.
      </p>

      <p>
        Without it, the pushes you made before the reset cannot be read again, by you or by us: they were encrypted with
        a key that only your old password or the recovery key could unlock. Your account gets new keys, and you can
        delete the old pushes in one step or keep them in your list as locked rows. Files are deleted within{' '}
        {LIMITS.pro.keepDays} days either way.
      </p>

      <h5>OLD VERSIONS OF THE APPS</h5>

      <p>
        A version of the app from before encryption cannot read an encrypted push, and its pushes are refused. It was
        not written to know why, so it may say the push could not be saved, or that you have used this month&rsquo;s
        pushes when you have not. Update it and the push goes through.
      </p>

      <h5>YOUR DEVICE ID</h5>

      <p>
        Each install of PushThat makes a random device ID, which the web app shows on the <Link to="/plan">Plan</Link>{' '}
        page. It goes with every push so that the device that sent one does not notify itself, and it says nothing about
        the device: it replaced the device&rsquo;s model name, which pushes used to carry.
      </p>

      <h5>QUESTIONS</h5>

      <p>
        Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a>. If you think you have found a security
        problem, say so in the subject.
      </p>
    </LegalContainer>
  );
}
