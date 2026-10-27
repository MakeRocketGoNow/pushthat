# Deploying

A push to `main` deploys itself. The CI workflow (`.github/workflows/ci.yml`) runs the
checks, and when they pass it deploys what the push changed to the `push-that` Firebase
project: the functions when `functions/` changed, and the site with the Firestore and
Storage rules when `apps/web/` changed. A change to `firebase.json` or `.firebaserc`
deploys both. Nothing else ships from CI: the Chrome extension, the Android app and the
Apple apps are still released by hand.

## What a deploy runs

Each deploy job runs the same `npm run deploy` that a deploy by hand runs, in its own
folder, so there is one definition of what a deploy is:

- **Functions** (`deploy-functions`): the emulator suite (`npm run test:emulator`), then
  `npm run deploy`, whose predeploy hooks lint and build.
- **Site and rules** (`deploy-web`): `npm run deploy`, which runs the rules tests, builds
  and deploys hosting, the Firestore rules and the Storage rules.

The emulator suites are not in the pull request checks (they need Java and the Firebase
CLI, and take a while), so this is the first place CI runs them. A failure there stops the
deploy, and the pull request that caused it is already merged: fix forward.

The functions deploy first. A change that adds a callable function and the page that
calls it would otherwise put the caller live before the callee. If the functions deploy
fails, the site deploy in that run doesn't start.

"What the push changed" is measured from the last push to `main` whose run succeeded,
not from the previous commit. GitHub drops waiting runs when a newer one queues behind
them, and a run that failed leaves its changes not yet live; diffing from the last commit
known to be live picks both up. When no such run exists, both deploy.

Runs on `main` are one at a time (the workflow's `concurrency` group), so two deploys
never overlap.

## Deploying by hand from CI

**Actions → CI → Run workflow**, on `main`, with what to deploy (`both`, `web` or
`functions`). The checks run first, as for a push. Use it:

- after a failed deploy, once whatever failed is fixed outside the repository;
- after `firebase functions:secrets:set`, since the functions read a secret's version when
  they deploy (see [billing](billing.md));
- the first time, to bring production up to `main`.

A run from any other branch runs the checks and deploys nothing.

## What stays manual

- **Deleting a function.** CI deploys with `--non-interactive`, and the Firebase CLI then
  refuses to delete a function that has gone from the source rather than asking. Delete it
  with `firebase functions:delete <name>` from the repository root, then rerun the deploy.
  A failed functions deploy also stops the site and rules deploy in the same run, so a
  removal is best done by hand just before the merge that drops the function, once no live
  client still depends on it.
  - `getPageTitle` went with the encrypted pushes (phase 5 of
    [end-to-end encryption](e2ee.md), Titles): `firebase functions:delete getPageTitle
    --region us-central1`. The web app only ever called it for a title and pushes without
    one when the call fails, so deleting it before the merge costs the site's pushes
    their titles for a few minutes and nothing else.
- **A new secret.** The deploy account can read secrets but not change who can read them,
  so the first deploy of a function that uses a new secret is made by hand
  (`npm run deploy` in `functions/`), which grants the functions' account access to it.
- **The Firestore indexes**, which aren't in `firebase.json`.
- **The Storage bucket's CORS.** Since phase 4 of [end-to-end encryption](e2ee.md) the web
  app and the Chrome extension read an encrypted file through the SDK (`getBlob`) and
  decrypt it in the page, rather than opening a download URL, and a browser reads the
  bucket from another origin only if the bucket says it may. Set once, from
  `apps/web`, with `gcloud storage buckets update gs://push-that.firebasestorage.app
  --cors-file=storage.cors.json`. Any origin may send a GET: a read still needs the
  user's own token, which goes in a header and not a cookie, so the CORS policy is not
  what keeps one account out of another's files (`storage.rules` is). Without it, opening
  a file on the web fails with "This file could not be decrypted." and a CORS error in
  the console; the apps are not affected.
- **The password reset email's action URL cannot be set.** The plan in
  [end-to-end encryption](e2ee.md) (Password reset) was the console's Authentication →
  Templates → Password reset → Customize action URL, pointed at
  `https://pushthat.link/reset`. Firebase refuses that change on this project:
  `EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`, from the console and from the Identity Toolkit API
  alike; a verified sender domain does not lift it, and a Firebase support case is the
  only known way to. Nothing is done in the console: resets run on Firebase's hosted form,
  whose Continue button leads to the web sign-in, and the sign-in asks for the recovery
  key. If the lock is ever lifted, set the URL and the `/reset` page takes over; nothing
  else changes.

## How CI signs in to Google Cloud

There is no key. GitHub gives each run an OIDC token that says which repository and branch
it is; Google Cloud's Workload Identity Federation trades that token for a short-lived
token for a deploy service account. Only a token from `ci.yml`, run on `main` of this
repository by a push or by hand, is accepted. A pull request, a fork, another branch or
any other workflow has nothing to trade. That keeps a long-lived credential out of
GitHub's secrets, where a leaked one would deploy to production until someone noticed.

Naming the workflow and the event matters even on `main`: a `pull_request_target`
workflow (the labeler is one) also runs on `main`, for a pull request someone else
opened. The labeler can't ask for a token today, but the condition shouldn't depend on
every future workflow remembering not to.

The workflow reads two repository **variables** (not secrets: neither grants anything on
its own), under Settings → Secrets and variables → Actions → Variables. Both are set:

| Variable                         | Value                                                                                    |
| -------------------------------- | ---------------------------------------------------------------------------------------- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | `projects/644804248017/locations/global/workloadIdentityPools/github/providers/pushthat` |
| `GCP_DEPLOY_SERVICE_ACCOUNT`     | `github-deploy@push-that.iam.gserviceaccount.com`                                        |

### One-time setup

Open [Cloud Shell on `push-that`](https://console.cloud.google.com/home/dashboard?project=push-that&cloudshell=true)
as a project owner and paste the block below. It turns on the two APIs the token exchange
uses, creates the deploy service account, gives it what a deploy needs, and trusts this
repository's `main` branch to act as it. Each step says what it did; one that reports
"already exists" on a second run is fine.

`1434615723` is the repository's numeric id (`gh api repos/MakeRocketGoNow/pushthat --jq .id`):
the condition checks the id rather than the name, so a repository that later takes the
name can't inherit the trust. Renaming or moving `ci.yml` breaks the condition, and the
deploy jobs then fail at sign-in until the provider is updated
(`gcloud iam workload-identity-pools providers update-oidc pushthat --location global
--workload-identity-pool github --attribute-condition "..."` with the new path).

```bash
PROJECT_ID=push-that
PROJECT_NUMBER=644804248017
REPO_ID=1434615723
SA=github-deploy@$PROJECT_ID.iam.gserviceaccount.com
gcloud config set project $PROJECT_ID

# The token exchange: STS trades GitHub's token, IAM Credentials mints the account's token.
gcloud services enable sts.googleapis.com iamcredentials.googleapis.com

gcloud iam service-accounts create github-deploy --display-name "GitHub Actions deploy"
# A new account takes a few seconds to be visible to IAM bindings.
sleep 15

for role in \
  roles/firebase.admin \
  roles/cloudfunctions.admin \
  roles/run.admin \
  roles/cloudscheduler.admin \
  roles/secretmanager.viewer \
  roles/artifactregistry.reader \
  roles/serviceusage.serviceUsageConsumer \
  roles/serviceusage.apiKeysViewer
do
  gcloud projects add-iam-policy-binding $PROJECT_ID --condition None --quiet \
    --member serviceAccount:$SA --role $role > /dev/null && echo "Granted $role"
done

# The functions run as the default compute account; deploying them means acting as it.
# The CLI also checks for acting as the App Engine default account before any functions
# deploy, and stops without it (found on the first CI deploy).
for account in $PROJECT_NUMBER-compute@developer.gserviceaccount.com $PROJECT_ID@appspot.gserviceaccount.com
do
  gcloud iam service-accounts add-iam-policy-binding $account --quiet \
    --member serviceAccount:$SA --role roles/iam.serviceAccountUser > /dev/null \
    && echo "Granted acting as $account"
done

gcloud iam workload-identity-pools create github --location global --display-name GitHub

gcloud iam workload-identity-pools providers create-oidc pushthat \
  --location global --workload-identity-pool github \
  --issuer-uri https://token.actions.githubusercontent.com \
  --attribute-mapping 'google.subject=assertion.sub,attribute.repository_id=assertion.repository_id,attribute.ref=assertion.ref' \
  --attribute-condition "assertion.repository_id == '$REPO_ID' && assertion.ref == 'refs/heads/main' && assertion.workflow_ref.startsWith('MakeRocketGoNow/pushthat/.github/workflows/ci.yml@') && assertion.event_name in ['push', 'workflow_dispatch']"

gcloud iam service-accounts add-iam-policy-binding $SA --quiet \
  --role roles/iam.workloadIdentityUser \
  --member "principalSet://iam.googleapis.com/projects/$PROJECT_NUMBER/locations/global/workloadIdentityPools/github/attribute.repository_id/$REPO_ID" \
  > /dev/null && echo "Trusted main of MakeRocketGoNow/pushthat"
```

If the project is ever recreated, its number changes: take the new one from
`gcloud projects describe push-that --format='value(projectNumber)'` and update both the
script and `GCP_WORKLOAD_IDENTITY_PROVIDER`.

The role list is what the CLI touches for this project: hosting and both rules
(`firebase.admin`), second-generation functions and their Cloud Run services, including
the public invoker on the HTTP and callable ones (`cloudfunctions.admin`, `run.admin`), the
two scheduled functions (`cloudscheduler.admin`), checking the three Stripe secrets exist
(`secretmanager.viewer`), the artifact cleanup policy (`artifactregistry.reader`), and the
API checks the CLI makes before it starts. If a deploy fails on a permission, the CLI's
error names it: grant the role that holds it and add it to this list.

## Updating the Firebase CLI

CI installs a pinned `firebase-tools` version (in both deploy jobs in `ci.yml`). Dependabot
doesn't see a global install, so it is bumped by hand. Keep it at or above what
`firebase-functions` in `functions/package.json` needs: an older CLI fails with
"Unexpected key extensions" while parsing the functions.
