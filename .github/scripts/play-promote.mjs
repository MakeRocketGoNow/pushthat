// Releases a build Play already has to the production track, for
// .github/workflows/android-promote.yml. Nothing is built or uploaded: the version code
// named is one a merge already sent to a testing track, so production gets the exact
// bundle testers ran, not a rebuild of whatever `main` has become since.
//
// Plain Node with no dependencies, on purpose. The alternatives were fastlane's `supply`
// and the Gradle Play Publisher plugin, each a dependency tree to keep current for the sake
// of four HTTP calls, and an action to mint the token, which would be one more entry on the
// repository's Actions allow-list with the production key in its hands. Signing the token
// request here keeps that key inside code this repository owns.

import { createSign } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const API = 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications';
// Fixed, not read from the key's own `token_uri`: the signed assertion is as good as the
// key for an hour, so where it is sent is not something the key file gets to decide.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/androidpublisher';

const PRODUCTION = 'production';
// The upload action, fastlane and Play Console's own URLs call the internal testing track
// `internal`; Google's API reference lists its name as `qa`. Which of the two a listing
// returns is not something to find out on a production release, so both are recognised
// and neither is ever asked for by name: the tracks are listed and looked through.
const INTERNAL = ['internal', 'qa'];

const base64url = (value) => Buffer.from(value).toString('base64url');

/** The signed request a service account trades for an access token (RFC 7523). */
export function tokenAssertion(key, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const unsigned = [
    base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' })),
    base64url(
      JSON.stringify({
        iss: key.client_email,
        scope: SCOPE,
        aud: TOKEN_URL,
        iat: issued,
        exp: issued + 600,
      }),
    ),
  ].join('.');
  const signature = createSign('RSA-SHA256').update(unsigned).sign(key.private_key);
  return `${unsigned}.${base64url(signature)}`;
}

async function accessToken(key, fetchImpl) {
  const response = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: tokenAssertion(key),
    }),
  });
  if (!response.ok) {
    throw new Error(`Google refused the service account (${response.status}): ${await response.text()}`);
  }
  return (await response.json()).access_token;
}

/** A `request(method, path, body)` bound to one app, for `promote`. */
export async function playClient(key, packageName, fetchImpl = fetch) {
  const token = await accessToken(key, fetchImpl);
  return async (method, path, body) => {
    const response = await fetchImpl(`${API}/${packageName}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) {
      throw new Error(`Play refused ${method} ${path} (${response.status}): ${await response.text()}`);
    }
    return response.json();
  };
}

/**
 * A whole percentage from 1 to 100. Play's own field is a fraction strictly between 0 and
 * 1, with 100% written as a different status instead, which is an easy thing to get wrong
 * by hand: 0.1 and 10 are both plausible things to type for "ten percent".
 */
export function parseRollout(text) {
  const percent = Number(text);
  if (!/^\d+$/.test(String(text).trim()) || percent < 1 || percent > 100) {
    throw new Error(`The rollout is a whole percentage from 1 to 100, not "${text}".`);
  }
  return percent;
}

const codesOf = (track) => (track.releases ?? []).flatMap((release) => release.versionCodes ?? []);

const newest = (codes) => codes.reduce((a, b) => (BigInt(b) > BigInt(a) ? b : a));

/**
 * Releases `versionCode` (or, when none is given, the newest build on internal testing) to
 * `percent` of production. Returns what it did, for the run's summary.
 */
export async function promote({ request, versionCode, percent }) {
  const edit = await request('POST', '/edits');

  // Every track in one call, each with the releases it is serving. Form factor tracks
  // (`wear:production`) are left out: this app has none, and a phone build is not what
  // one of them would want promoted.
  const listed = ((await request('GET', `/edits/${edit.id}/tracks`)).tracks ?? []).filter(
    (track) => !track.track.includes(':'),
  );
  // Production first, so that running again with a larger percentage finds the rollout
  // already under way and widens it, keeping its name and note, instead of starting over
  // from the copy on a testing track.
  const tracks = [...listed.filter((t) => t.track === PRODUCTION), ...listed.filter((t) => t.track !== PRODUCTION)];

  let code = versionCode ? String(versionCode).trim() : '';
  if (!code) {
    const internal = tracks.filter((t) => INTERNAL.includes(t.track)).flatMap(codesOf);
    if (internal.length === 0) {
      throw new Error('Internal testing has no build to promote. Name a version code.');
    }
    code = newest(internal);
  }

  let from;
  let source;
  for (const track of tracks) {
    source = (track.releases ?? []).find((release) => (release.versionCodes ?? []).includes(code));
    if (source) {
      from = track.track;
      break;
    }
  }
  // Play would accept any code it has ever been sent, but a build no track is serving has
  // no note to carry over and nobody currently running it. Refusing is also what catches a
  // mistyped code before it reaches production rather than after.
  if (!source) {
    const available = tracks.map((t) => `${t.track}: ${codesOf(t).join(', ') || 'none'}`).join('; ');
    throw new Error(`No track is serving version code ${code} (${available || 'no tracks'}). Promote an older build in Play Console.`);
  }
  if (from === PRODUCTION && source.status === 'completed') {
    throw new Error(`Version code ${code} is already released to all of production.`);
  }

  const release = {
    name: source.name,
    versionCodes: [code],
    releaseNotes: source.releaseNotes,
    // `userFraction` may only accompany `inProgress`, and must be below 1: everyone is
    // `completed` with no fraction at all.
    ...(percent === 100 ? { status: 'completed' } : { status: 'inProgress', userFraction: percent / 100 }),
  };

  // Only the new release is listed. The build production already serves in full stays for
  // everyone outside the fraction without being named: `releases` in an update is the
  // desired change, not the whole track, and Google's own staged rollout examples send
  // exactly this.
  await request('PUT', `/edits/${edit.id}/tracks/${PRODUCTION}`, { track: PRODUCTION, releases: [release] });

  // Nothing above is real until this call: an edit is a draft on Play's side, and one that
  // is never committed (because a step above threw) simply expires. Committing is what
  // sends the release to Play's review.
  await request('POST', `/edits/${edit.id}:commit`);

  return { code, from, percent, name: source.name };
}

async function main() {
  const { PLAY_SERVICE_ACCOUNT_JSON, PLAY_PACKAGE_NAME, VERSION_CODE, ROLLOUT_PERCENT, GITHUB_STEP_SUMMARY } =
    process.env;
  if (!PLAY_SERVICE_ACCOUNT_JSON) {
    throw new Error('No PLAY_SERVICE_ACCOUNT_JSON on the `play-production` Environment: nothing to publish with.');
  }
  if (!PLAY_PACKAGE_NAME) throw new Error('PLAY_PACKAGE_NAME is not set.');
  // Before anything is sent, so a typo costs nothing.
  const percent = parseRollout(ROLLOUT_PERCENT);

  const request = await playClient(JSON.parse(PLAY_SERVICE_ACCOUNT_JSON), PLAY_PACKAGE_NAME);
  const done = await promote({ request, versionCode: VERSION_CODE, percent });

  const line =
    done.from === PRODUCTION
      ? `Widened the production rollout of ${done.name ?? done.code} to ${done.percent}%.`
      : `Sent ${done.name ?? done.code} from ${done.from} to ${done.percent}% of production. Play reviews it before anyone gets it.`;
  console.log(line);
  if (GITHUB_STEP_SUMMARY) appendFileSync(GITHUB_STEP_SUMMARY, `${line}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
