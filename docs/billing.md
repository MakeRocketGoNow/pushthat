# Billing

PushThat sells one plan, Pro, at $24 a year, through Stripe Managed Payments: Stripe is the merchant of record, so it works out, collects and remits sales tax and VAT, and handles disputes and transaction-level support. The shape follows [Unbent's](https://github.com/MakeRocketGoNow/unbent/blob/main/docs/billing.md), adapted to Firebase: Cloud Functions make the checkout and portal sessions and receive the webhook, and the webhook writes `users/{uid}.subscription`, which the Firestore rules read to pick the account's limits.

Checkout happens on the web app only. The Android, iOS and macOS apps show the plan and its limits but draw no purchase button, since both stores forbid selling a subscription in an app through anything but their own billing.

## The plan

|                     | Free   | Pro ($24/yr) |
| ------------------- | ------ | ------------ |
| URL pushes a month  | 50     | 10,000       |
| File pushes a month | 3      | 100          |
| File size           | 25 MB  | 100 MB       |
| Files kept          | 7 days | 30 days      |

A file's retention is decided when it is pushed, from the tier at that moment, and nothing moves it afterwards: subscribing does not extend files already pushed, and a lapse does not shorten them. The Plan page says so. Re-stamping on a tier change would need a composite index on `userId` and `expiresAt`, and was not worth it for a push that is a hand-off, not storage.

Decided 2026-10-25. A URL push costs about $0.00002 to serve, so the URL limits are abuse caps. Files cost through download egress ($0.12 per GB past the project's free 100 GB a month) and storage; a Pro account at every limit at once is 10 GB a month, $1.50 to $2.70, against $22.16 kept after Stripe's fees (about 6.4% + 30 cents). That worst case was accepted knowingly; real use is far below it. Billing is yearly only because the fixed 30 cents takes a fifth of a $2 monthly charge.

## Stripe accounts

Both under MakeRocketGoNow LLC, as separate accounts rather than an organization, like Unbent and CurlHub.io.

- **PushThat** (live): `acct_1UUVWeEGHR9topvw`
- **PushThat sandbox**: `acct_1UUVWkEJNixT7uDa`

### Sandbox

Set up on 2026-10-25.

- **Product:** PushThat Pro, `prod_VVWkWeG0cIT51z`, tax code `txcd_10103000` (software as a service for personal use)
- **Price:** $24 a year, `tax_behavior: exclusive`, `price_1UUVggEJNixT7uDaaVEcm1i6`
- **Customer portal:** `bpc_1UUVh2EJNixT7uDa2ChCsS3U`, the default configuration. Invoice history, the card, name, email and address editable, cancelling at the period's end with a reason asked for. Plan changes are off. Returns to `https://pushthat.link/plan`; terms and privacy links are `/terms` and `/privacy`.
- **Webhook:** `we_1UUVhAEJNixT7uDa9cl3QtUg` at `https://us-central1-push-that.cloudfunctions.net/stripeWebhook`, API version `2025-03-31.basil`, for `customer.subscription.created`, `updated`, `deleted`, `paused` and `resumed`, `invoice.paid`, `charge.refunded` and `charge.dispute.created`. Its signing secret is shown in the endpoint's page in Workbench.

There is one Firebase project, `push-that`, so the sandbox's webhook points at production's function. That is deliberate until launch (decided 2026-10-25): production runs on the sandbox's three settings while billing is tested end to end against the deployed functions, then all three are replaced with the live account's at once. The three always come from the same environment, since the key picks the account checkouts are made in, the webhook secret verifies only that account's endpoint, and the price id must be a price in it.

While production is on the sandbox, anyone who reaches the Plan page can subscribe with a test card and get Pro, so the web app does not link to it or show it until launch.

| Secret                  | Before launch                                    | At launch                                                                               |
| ----------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------- |
| `STRIPE_SECRET_KEY`     | The sandbox's secret key, `sk_test_…`            | The live restricted key `pushthat-functions`, `rk_live_…`, kept in 1Password until then |
| `STRIPE_WEBHOOK_SECRET` | The sandbox endpoint's signing secret, `whsec_…` | The live endpoint's signing secret                                                      |
| `STRIPE_PRO_PRICE_ID`   | `price_1UUVggEJNixT7uDaaVEcm1i6`                 | The live Pro price                                                                      |

Each is set with `firebase functions:secrets:set <NAME>` from the repository root, which prompts for the value without echoing it; a redeploy picks up a new version. Locally, `stripe listen --forward-to http://127.0.0.1:5001/push-that/us-central1/stripeWebhook` forwards the sandbox's events to the emulator, and the `whsec_` it prints is the local signing secret while it runs.

### Live

Set up on 2026-10-25, the same as the sandbox:

- **Product:** PushThat Pro, `prod_VVWkWeG0cIT51z`, tax code `txcd_10103000`
- **Price:** $24 a year, `tax_behavior: exclusive`, `price_1UUWbGEGHR9topvwqqaIG04E`
- **Customer portal:** `bpc_1UUaYfEGHR9topvw6i6YCwpQ`, the default configuration, as the sandbox's.
- **Webhook:** `we_1UUaYrEGHR9topvww90tiCZ4` at `https://us-central1-push-that.cloudfunctions.net/stripeWebhook`, API version `2025-03-31.basil`, the same eight events. Its signing secret is shown in the endpoint's page in Workbench.
- **Restricted key:** `pushthat-functions`, `rk_live_…`, in 1Password (Customers, Checkout Sessions, Subscriptions and Customer Portal to write; Invoices, Charges and Refunds to read).

Set in the dashboard, since the API cannot:

- Managed Payments activated (Settings, Managed Payments), which goes through Stripe's eligibility review. A checkout fails until it is.
- Public details (Settings, Business, Public details): support email and `https://pushthat.link/support` as the support website.
- Checkout terms (Settings, Checkout and Payment Links): `/terms` and `/privacy`.
- Revenue recovery (Billing, Revenue recovery): Smart Retries, failed-payment emails and automatic card updates on. Matters more on a yearly plan, since a card often expires within the year.

Once the three secrets hold the live values, the functions are redeployed (they read the secret versions current at deploy) and `PLAN_PAGE_LINKED` is turned on in the web app. The sandbox's webhook endpoint points at the same function, so it was disabled at the switch (2026-10-25): its deliveries fail the live signature. Re-enable it only with the sandbox's three secrets back in place.

## How it is built

The functions are in `functions/src`: `plan.ts` (the tiers, and the plan as the clients are told it), `stripe.ts` (the Stripe client, a port of Unbent's), `stripe-events.ts` (what each event does to a user document) and `stripe-functions.ts` (the callables and the webhook). On `users/{uid}`:

- `subscription` is what the Firestore rules read to pick the account's limits: Pro while `expiresAt` is ahead of the clock. The webhook keeps it in step with Stripe (`type: 'pro'`, `status`, `startedAt`, which anchors the month the usage is counted in, `cancelsAt`, `canceledAt`).
- `billing` is how the webhook finds and orders events: `customerId`, `subscriptionId`, `subscriptionStatus` and `eventAt`, the newest event applied, so an older delivery cannot write over a newer one.
- A comp is `subscription: { type: 'comp', expiresAt: <end, or far ahead> }`, set by hand in the console. The webhook leaves the account alone while it runs, and the checkout refuses it. Never a 100% Stripe coupon, which still asks for a card.

`stripeCustomers/{customerId}` names the account a customer belongs to, written before the first checkout opens; `billingEvents/{eventId}` records each event once, with an `expireAt` thirty days on: turn on a Firestore TTL policy for that field on the collection (Firestore, Time-to-live, in the console) so the records age out, since one only has to outlive the three days Stripe retries for. Clients write none of these (the rules allow only `email`, `createdAt` and `fcmTokens`).

The callables: `getPlan` (the tier, this period's usage and the subscription), `createCheckoutSession` (the Stripe customer on first use, then the hosted checkout's address, back to `/plan?checkout=complete`), `createPortalSession` and `refreshSubscription` (the subscription read from Stripe and applied, for the page straight after a checkout). `stripeWebhook` is an HTTP function: a delivery is accepted only from an address on Stripe's published list and with a valid signature over the raw body, each event is applied once in any order, and a refund or a dispute cancels the subscription at once.

File pushes made before expiry existed have no `expiresAt`; the sweep's first run stamps them once (`stampLegacyFilePushes`, recorded at `system/expiryBackfill` so it never runs twice), after which it treats them like any other.

A file is uploaded before its push is made, so an upload whose push never comes (refused at the limit, a crash, or a direct call to the Storage SDK) is held by no push document and so by no retention. The clients delete their upload when the push is refused; for the rest, `deleteOrphanedUploads` (`orphans.ts`) runs daily and deletes any object under `uploads/` that is more than seven days old and that no file push names, by its title's path or its download URL's. Seven days is the shortest retention, so an orphan is kept no longer than a Free file, and it covers an upload in flight and Android's retry of a push that failed on the network after its file was uploaded, which waits for a connection; a retry later than that makes a push whose file is gone.

Locally, the three secrets go in `functions/.secret.local` (ignored by git) as `NAME=value` lines, and `stripe listen` forwards the sandbox's events to the emulator as above. `APP_URL` may be set in the emulator's environment to send the checkout back to a local web app.

The rules are tested on their own with `npm test` (`plan.test.ts`, `stripe.test.ts`, `stripe-events.test.ts`). The glue around them, the webhook's refusals and its event record, the stamp's guard in `applyPatch`, the order deliveries land in, the refresh, the checkout, and the expiry sweep and backfill, is tested against the Firestore emulator with `npm run test:emulator` (`functions/test/emulator`, a Java runtime and the Firebase CLI needed), and so is the orphan sweep's listing, paging, cap and deletes, against the Storage emulator beside it. A run needs the emulator ports free (8080 and 9199) and refuses to start otherwise, naming the port: one run cannot share another's emulators. The emulators load the rules the root `firebase.json` names, but the suites drive the functions through the Admin SDK, which rules never apply to, so they say nothing about what the clients may do: the rules live in `apps/web` and are tested there with `npm run test:rules`. Those suites deliver signed events to the webhook over HTTP and point `STRIPE_API_URL` at a stand-in for Stripe's API, so nothing reaches Stripe.
