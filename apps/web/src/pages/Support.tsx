import { Helmet } from 'react-helmet';
import { Link } from 'react-router';

import LegalContainer from '@/components/LegalContainer';
import { LIMITS, PLAN_PAGE_LINKED, PRO_PRICE_USD, REFUND_DAYS, SUPPORT_EMAIL, formatMb } from '@/config/plan';

/**
 * Support, `/support`: how to reach a person, and where everything else is. Written for
 * the reader a receipt sends here: Stripe is the merchant of record and its receipts,
 * renewal mails and public details carry this address as the business's support site.
 * Public, since the person reading it may have no session or no account any more.
 */
export default function Support() {
  return (
    <LegalContainer>
      <Helmet>
        <title>Support</title>
      </Helmet>

      <h1>Support</h1>

      <p>
        Write to <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> from the address on your account. A person
        reads every message, and you will hear back within a few days.
      </p>

      <h5>RECEIPTS, REFUNDS AND CANCELLING</h5>

      <p>
        PushThat Pro is ${PRO_PRICE_USD} a year, before tax. Payments are taken by Stripe, which is the seller of record
        under its Link name: the receipt comes from Stripe, and on a card statement the charge begins with{' '}
        <code>LINK.COM*</code> and names PushThat.
      </p>

      <p>
        To change your card, download an invoice or cancel, open{' '}
        {PLAN_PAGE_LINKED ? <Link to="/plan">Plan</Link> : 'Plan'} in the web app and choose Manage billing. Cancelling
        stops the next renewal and keeps Pro until the year already paid for ends.
      </p>

      <p>
        Any charge is refunded in full if you ask within {REFUND_DAYS} days, and no reason is needed: write to us from
        the address the account uses, or use the support link in Stripe’s receipt. The{' '}
        <Link to="/terms#refunds">refund policy</Link> is in the terms. If you stop paying, the account goes back to the
        free plan; nothing you have pushed is taken away.
      </p>

      <h5>SIGNING IN</h5>

      <p>
        You sign in with your email address and a password. A forgotten password is reset from the sign-in page, with a
        link sent to your address; a link that does not arrive is usually in a spam folder, or went to a different
        address from the one the account was made with. If you have lost access to the address on your account, write to
        us and say what you can about it.
      </p>

      <h5>YOUR PUSHES</h5>

      <p>
        Links are kept until you delete them. Files are a hand-off to another device, not storage: a file push is
        deleted after {LIMITS.free.keepDays} days on the free plan and {LIMITS.pro.keepDays} days on Pro, and the
        largest file is {formatMb(LIMITS.free.fileBytes)} on the free plan and {formatMb(LIMITS.pro.fileBytes)} on Pro.
      </p>

      <p>To close your account, write to us from its address and we will delete it, with everything pushed from it.</p>

      <h5>BUGS AND IDEAS</h5>

      <p>
        Something broken, or something PushThat should do? Write to{' '}
        <a href={`mailto:${SUPPORT_EMAIL}`}>{SUPPORT_EMAIL}</a> and say which device and app you were using.
      </p>
    </LegalContainer>
  );
}
