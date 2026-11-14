# Account deletion

Anyone with an account can delete it, with everything stored under it, from inside each
app and from a public page, [pushthat.link/delete-account](https://pushthat.link/delete-account).
Google Play requires both of any app that lets people make an account, and requires that
deleting the account deletes its data: an account that is only switched off does not count.

## What an account is, and where it lives

Everything the project holds about an account is keyed by its Firebase uid:

| Where                                    | What                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Firebase Authentication                  | The email address, the password hash, the sessions                                              |
| `users/{uid}`                            | Email, device notification tokens, the wrapped account key and recovery wrap, usage, plan, Stripe ids |
| `pushes` where `userId` is the uid       | The encrypted links and file records, with their search tokens and device ids                   |
| Storage, `uploads/{uid}/`                | The encrypted files                                                                             |
| `stripeCustomers`, `billingEvents`       | Which Stripe customer is the account's, and the webhook events applied to it                    |
| Stripe                                   | The customer (email) and its subscription                                                       |

`functions/src/account-deletion.ts` empties all of them. Its emulator suite
(`functions/test/emulator/account-deletion.test.ts`) does not list those places: it seeds
an account, deletes it, and then walks the whole database, the whole bucket and the Auth
emulator for the uid. A collection added later that is keyed by the account and missed by
the purge fails that suite without anyone remembering to add it.

## The `deleteAccount` callable

A Firebase callable, `https://us-central1-push-that.cloudfunctions.net/deleteAccount`,
called with the account's ID token and an empty payload. It answers `{ deleted: true }`.

**It needs a sign-in no older than five minutes** (`FRESH_SIGN_IN_S`, read from the token's
`auth_time`). Every client asks for the password and signs in again right before the call.
The check is in the function because one made only in a client is one a modified client
skips. The function is not given the password itself: Firebase's password for an account
is a key derived from it (see [end-to-end encryption](e2ee.md)), and the sign-in that
proves it is the one every client already has.

In order:

1. **Stripe.** Open checkouts are ended, any subscription still running is cancelled, and
   the customer is deleted. This goes first because it is the one step that can refuse,
   and a deleted account that is still charged at its renewal has no page left to cancel
   from: if the subscription cannot be cancelled, nothing has been deleted yet and the
   person is told to try again. A customer that will not delete does not stop the rest;
   it is logged to be removed by hand. No refund is made here: the refund policy is a
   separate request (the terms, Refunds).
2. **A marker**, `accountDeletions/{uid}`, holding two times and nothing else (see below).
3. **The refresh tokens are revoked**, so no device can renew its session.
4. **The data**: the pushes, everything under `uploads/{uid}/`, the billing rows, and
   `users/{uid}` with anything under it.
5. **The Auth user**, last. It is what lets the person ask again, so if a step before it
   fails they can still sign in, and the next call picks up where this one stopped.

Deleting the pushes starts `onPushRecordDeleted` once per push, link pushes included: for
those it logs a line and returns. An account with tens of thousands of pushes therefore
costs that many short invocations and log lines when it is deleted. That is the trigger as
it has always been, and account deletion is the first thing to delete in bulk; it is noted
here so the burst in the logs after a large deletion is recognised for what it is.

Every step is content to find its work already done, so the call is idempotent: a second
call, or one for an account already deleted (its last ID token can still reach the function
for an hour), succeeds and changes nothing.

## Signing out the other devices, and the second purge

Deleting the Auth user signs a device out when its ID token next refreshes, which is up to
an hour away. Until then that token still passes the Firestore and Storage rules, so a
phone left signed in could write its notification token back to `users/{uid}`, and a push
made in the same second as the deletion can still be counted by `onNewPushCreated`
afterwards, which makes the user document it does not find.

Refusing those writes in the rules would mean reading a second document on every push for
the life of the project. Instead `finishAccountDeletions` runs every hour and, for each
marker older than 70 minutes (an ID token's hour, and ten minutes for a slow clock or a
late trigger), empties the same places again and removes the marker. So the first purge is
immediate, and the second is what makes "nothing is left" true without depending on what
the clients do. The marker is the only thing kept about a deleted account in our own
database, for at most about two hours.

The same hour is why `createCheckoutSession` refuses an account that has a marker, and why
the sweep asks Stripe again before it purges: a subscription bought with the deleted
account's last token would otherwise renew with nothing left that points at it. Outside
the emulator the function also refuses, before deleting anything, when the account has a
Stripe customer and billing is not configured, for the same reason.

## What cannot be deleted at once

This is the list the public page and the Play Data safety form are written from. If one of
these changes (a backup turned on, a log retention raised), change the page with it.

| What                                              | Kept for                        | Why                                                                  |
| ------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------- |
| The marker, `accountDeletions/{uid}`              | About two hours                 | The second purge, above                                              |
| Server logs (Cloud Logging)                       | 30 days, Cloud Logging's default | The functions log the uid and stored file paths, never an email or push content |
| Google's backups of Authentication, Firestore and Storage | Up to 180 days            | Google's own disaster-recovery copies, which expire on its schedule and cannot be read out per account |
| Payment records at Stripe                         | As long as tax law requires     | Stripe is the seller of record and keeps its own books               |
| Google Analytics for Firebase events (Android, iOS) | Up to 14 months               | Not keyed to the account or email, only to an installation id, which the app resets on deletion |

Three of these depend on settings outside the repository, which nothing here can check:

- **Firestore backups and point-in-time recovery are off**, and must stay off or be added
  to the table: with either on, a deleted account's documents would be restorable for the
  backup's retention. What a restore could bring back is ciphertext whose key is gone,
  apart from the email and the device tokens, which are plaintext.
- **The Storage bucket's soft delete.** A bucket made since 2024 keeps deleted objects for
  seven days by default. Turn it off for `push-that.firebasestorage.app`
  (`gcloud storage buckets update gs://push-that.firebasestorage.app --clear-soft-delete`),
  or add seven days to the table and the page. The objects are ciphertext either way.
- **Analytics retention** is set in the Analytics property (Admin, Data retention): two
  months or fourteen. The page says "up to 14 months", which holds for both.

## Local data on each device

After the function answers, the client that asked clears what it holds and signs out. What
each client holds differs, because each keeps different things:

| | Web and extension | Android | iOS | macOS |
| --- | --- | --- | --- | --- |
| The account key and any unconfirmed recovery key | yes | yes | yes | yes |
| Decrypted files in the cache | none kept | yes | yes | yes |
| Pushes queued for a retry | none kept | yes | yes | yes |
| Icons decoded from the list's pushes, in memory | until the tab closes | until the app closes | until the app closes | until the app closes |
| The notification (FCM) token | not held by the page | yes | yes | no FCM |
| The Analytics installation id | no Analytics | yes | yes | no Analytics |

On Android, a process killed during the call (the app swiped out of Recents) never gets to
this cleanup: the session ends on its own once its revoked token is refused and the key
goes with it, but the queued pushes and the notification token stay until that install is
next signed out.

The decoded icons are the one thing here that outlives the sign-out: each app keeps a
bounded cache of the icons it has drawn, in memory only, which neither sign-out nor deletion
empties. They go with the process.

The device id stays everywhere, as it does at sign-out: it belongs to the install, not the
account. The extension's worker keeps its own FCM token in `chrome.storage`; it stops being
addressed when the user document goes, and is replaced at the next sign-in.

## When the client hears nothing back

The function may run for five minutes on a large account, so every client waits a little
longer than that (310 seconds). If the call still ends with no answer (a dropped connection,
a crash on the server), the client does not know how far the deletion got, and must not say
"nothing was deleted": past Stripe the marker is written and the sweep will finish the job
regardless. It asks Firebase whether the account still exists. The Auth user is the last
thing deleted, so gone means done, and the client clears its local data and signs out;
otherwise it says the outcome could not be confirmed, and that the account is gone once
signing in with the right password no longer works. A retry that finds the account already
gone is treated as the deletion having succeeded, on the apps. With email enumeration
protection on, Firebase refuses a deleted account's password exactly as it would a wrong
one, so the apps ask about the session they already hold (`reload`) and count only "no such
user". A revoked session does not count there: a password change or reset on another device
revokes every session too, and reading that as "deleted" told someone who had mistyped that
their account was gone when the server had not been asked. It counts only straight after the
deletion's own sign-in, when nothing but the function can have revoked it. The web cannot
tell the two apart (Firebase answers both with "token expired" there), so a retry on the web
reports a refused password ("That is not your password." when the browser is signed in, "The
email or password is not right." when it is not), and the unconfirmed message says what that
means. Only the function's own refusals (an old sign-in, a subscription that would not
cancel), which are made before anything is deleted, are shown as refusals.

## The public page

`/delete-account` (`apps/web/src/pages/DeleteAccount.tsx`) names the app and the developer,
gives the steps, lists what is deleted and what is kept, and has the form. It is one of the
static pages ([the web app](web.md#pages-that-read-without-javascript)), so all of it but
the form reads without JavaScript, and it is reachable signed out: the person may have
uninstalled every app. A static page may not import Firebase or hold state, so the form is
a component of its own (`components/DeleteAccountForm.tsx`) that the page fetches once it
is on screen. The form signs in on a second Firebase app that lives only for
the call (`services/account.ts` says why), so it works the same signed in or out. Someone
who has forgotten their password resets it first; someone who cannot sign in at all writes
to support.

The website's and the extension's Account page (from the menu) links to this page. The Android, iOS and macOS
apps ask for the password in a dialog of their own and call the function directly.
