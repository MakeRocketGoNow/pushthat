# PushThat

Send links and files between your phone and your other devices.

Share a link or a file from Android or iOS and it arrives on your computer: the Chrome
extension opens it in a new tab, and the web app and the macOS app list it. Push from the
browser and it arrives on the phone as a notification. Everything you push is in one list
on every device, searchable, until you delete it (links) or it expires (files).

It runs at [pushthat.link](https://pushthat.link).

## The plan

|                     | Free   | Pro ($24/yr) |
| ------------------- | ------ | ------------ |
| URL pushes a month  | 50     | 10,000       |
| File pushes a month | 3      | 100          |
| File size           | 25 MB  | 100 MB       |
| Files kept          | 7 days | 30 days      |

Pro is sold on the web app only, through Stripe; the Android, iOS and macOS apps show the
plan but sell nothing, since the stores forbid selling a subscription in an app any other
way than their own. [Billing](docs/billing.md) has the reasoning behind the numbers.

## What you can check here

The apps and the Firestore and Storage rules are what decide what a client can read and
write, and they are all here: [apps/web/firestore.rules](apps/web/firestore.rules) and
[apps/web/storage.rules](apps/web/storage.rules), with their tests beside them. The Cloud
Functions are here too, but nothing proves that what runs on pushthat.link is this code, so
that part you take on trust. Pushes are not end-to-end encrypted today: Firebase holds them
as you sent them. [End-to-end encryption](docs/e2ee.md) is the design for changing that,
and none of it has shipped yet.

## Layout

```
apps/web            Vite + React site, and the Chrome extension built from the same code
apps/android        Kotlin app: the push list, the share target, notifications
apps/ios            Swift app: the push list, a share extension, notifications
apps/macos          Swift app: a fork of the iOS app for the Mac, with a share extension
functions           Cloud Functions: billing, the Stripe webhook, file expiry and cleanup
packages/push-test  A Node script that sends one test push through FCM
docs                Design records and per-app notes
```

There is one Firebase project, `push-that`, and one `firebase.json` at the root: hosting
serves `apps/web/dist`, the rules are read from `apps/web`, and the functions deploy from
`functions`. Each npm folder keeps its own `package-lock.json` and is installed on its own;
there is no workspace. `apps/android` is a Gradle project built with its own wrapper, and
`apps/ios` and `apps/macos` are Xcode projects.

## Documentation

Everything else is in [docs/](docs/README.md): [the web app and the Chrome extension](docs/web.md),
[the Android](docs/android.md), [iOS](docs/ios.md) and [macOS](docs/macos.md) apps,
[deploying](docs/deploying.md), [billing](docs/billing.md), and
[end-to-end encryption](docs/e2ee.md).
[AGENTS.md](AGENTS.md) holds the conventions the code follows and how to verify a change.

## License

PushThat is source-available, not open source: the whole repository, apps included, is
under the [Elastic License 2.0](LICENSE.md) (`Elastic-2.0`).

What it permits: use PushThat and modify it; run it for yourself, your family, or your own
company; redistribute the source; build the apps from it. What it forbids: offering it to
others as a hosted or managed service. That is the restriction that matters here, and it is
what keeps the hosted service viable while the code stays public. The license has two
more, which cost nothing in practice: its license-key clause, which PushThat has no license
keys for it to apply to, and its notices clause, which means keeping the copyright and
license text in any copy you pass on.

Bug reports and ideas are welcome as issues; outside pull requests are not being accepted
for now. See [CONTRIBUTING.md](CONTRIBUTING.md).
