import { Helmet } from 'react-helmet';

import LegalContainer from '@/components/LegalContainer';

import styles from './Privacy.module.css';

export default function Privacy() {
  return (
    <LegalContainer className={styles.root}>
      <Helmet>
        <title>Privacy Policy</title>
      </Helmet>

      <h1>PushThat Privacy Policy</h1>

      <p>
        This Privacy Policy describes how your personal information is collected, used, and shared when you visit or
        make a purchase from https://pushthat.link (the “App”).
      </p>

      <h5>PERSONAL INFORMATION WE COLLECT</h5>

      <p>
        When you visit the App, we automatically collect certain information about your device, including information
        about your web browser, IP address, time zone, and some of the cookies that are installed on your device.
        Additionally, as you browse the App, we collect information about the individual web pages you view, what
        websites or search terms referred you to the App, and information about how you interact with the App. We refer
        to this automatically-collected information as “Device Information.” The Urls and files you share via the App
        are stored in a database. They are not collected as part of "Device Information".
      </p>

      <p>We collect Device Information using the following technologies:</p>
      <ul>
        <li>
          “Cookies” are data files that are placed on your device or computer and often include an anonymous unique
          identifier. For more information about cookies, and how to disable cookies, visit{' '}
          <a href="http://www.allaboutcookies.org">{'http://www.allaboutcookies.org'}</a>.
        </li>
        <li>
          “Log files” track actions occurring on the App, and collect data including your IP address, browser type,
          Internet service provider, referring/exit pages, and date/time stamps.
        </li>

        {/* <li>
                “Web beacons,” “tags,” and “pixels” are electronic files used to record information about how you browse
                the App.
              </li> */}
      </ul>

      <p>
        When you subscribe to Pro, the payment is taken by Stripe, which is the merchant of record for the purchase. We
        do not receive or keep your card number or any other financial information: all of it is provided directly to
        Stripe, whose use of your personal information is governed by its privacy policy at{' '}
        <a href="https://stripe.com/privacy">{'https://stripe.com/privacy'}</a>. We keep the identifiers Stripe assigns
        to your customer and subscription, and the dates your plan runs between, so that the App knows which plan your
        account is on. We refer to this as “Subscription Information.”
      </p>

      <p>
        By registering or authenticating via our email and password login, Users allow the App to identify them and give
        them access to the App's services.
      </p>

      <p>
        When we talk about “Personal Information” in this Privacy Policy, we are talking both about Device Information
        and Subscription Information.
      </p>

      <h5>HOW DO WE USE YOUR PERSONAL INFORMATION?</h5>

      <p>
        We use the Subscription Information that we collect generally to fulfill your subscription to the App.
        Additionally, we use this Subscription Information to communicate with you.
      </p>

      <p>
        We use the Device Information that we collect to help us screen for potential risk and fraud (in particular,
        your IP address), and more generally to improve and optimize our App (for example, by generating analytics about
        how our customers browse and interact with the App, and to assess the success of our marketing and advertising
        campaigns).
      </p>

      <h5>SHARING YOUR PERSONAL INFORMATION</h5>

      <p>We do not sell our users’ private personal information.</p>

      <p>
        We share your Personal Information with third parties only to provide the App. We use Stripe to sell and bill
        Pro subscriptions, and share your email address with it so that it can issue receipts and renewal notices; you
        can read more about how Stripe uses your Personal Information at{' '}
        <a href="https://stripe.com/privacy">{'https://stripe.com/privacy'}</a>. The App itself runs on Google’s
        Firebase, which stores your account, the links and files you push, and the device tokens that deliver them.
      </p>

      <p>
        Finally, we may also share your Personal Information to comply with applicable laws and regulations, to respond
        to a subpoena, search warrant or other lawful request for information we receive, or to otherwise protect our
        rights.
      </p>

      <h5>DO NOT TRACK</h5>

      <p>
        Please note that we do not alter our App’s data collection and use practices when we see a Do Not Track signal
        from your browser.
      </p>

      <p>
        If you are a European resident, you have the right to access personal information we hold about you and to ask
        that your personal information be corrected, updated, or deleted. If you would like to exercise this right,
        please contact us through the contact information below.
      </p>

      <p>
        Additionally, if you are a European resident we note that we are processing your information in order to fulfill
        contracts we might have with you (for example if you create a subscription through the App), or otherwise to
        pursue our legitimate business interests listed above. Additionally, please note that your information will be
        transferred outside of Europe, including to Canada and the United States.
      </p>

      <h5>DATA RETENTION</h5>

      <p>
        When you create a subscription through the App, we will maintain your Subscription Information for our records
        unless and until you ask us to delete this information.
      </p>

      <p>The App is not intended for individuals under the age of 18.</p>

      <h5>CHANGES</h5>

      <p>
        We may update this privacy policy from time to time in order to reflect, for example, changes to our practices
        or for other operational, legal or regulatory reasons.
      </p>

      <h5>CONTACT US</h5>

      <p>
        For more information about our privacy practices, if you have questions, or if you would like to make a
        complaint, please contact us by e-mail at hello@pushthat.link
      </p>
    </LegalContainer>
  );
}
