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

After the function answers, the client that asked clears what it holds and signs out: the
account key and any unconfirmed recovery key, the decrypted file cache, and the queue of
pushes waiting to be retried. On Android and iOS it also resets the installation's
Analytics id. The device id stays, as it does at sign-out: it belongs to the install, not
the account.
