# PushThat documentation

The [front page](../README.md) says what PushThat is. These pages are the rest: each is a
design record as much as a manual, with the decision and the reason for it, which is the
house style ([AGENTS.md](../AGENTS.md)).

- [The web app and the Chrome extension](web.md): one codebase, two builds; why pushes are
  received in the extension; the Axiom token; the rules and deploying.
- [Android app](android.md): building, running on an emulator, release signing.
- [iOS app](ios.md): building, signing, notifications, and how it matches Android.
- [macOS app](macos.md): the fork of the iOS app, and how it differs.
- [Billing](billing.md): the plan, the Stripe accounts, and how the functions and the rules
  enforce it.
- [End-to-end encryption](e2ee.md): the specification for encrypting pushes. A design; none
  of it has shipped yet.
