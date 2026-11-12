// Run with `node --test '.github/scripts/*.test.mjs'`. Play is a stand-in throughout: these prove what
// the script asks Play for, not that Play agrees, which only a real promotion can.

import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';

import { parseRollout, playClient, promote, tokenAssertion } from './play-promote.mjs';

const NOTES = [{ language: 'en-US', text: 'Something a tester would notice.' }];

/** A Play with the given tracks, recording every call made to it. */
function fakePlay(tracks) {
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (method === 'POST' && path === '/edits') return { id: 'edit-1' };
    if (method === 'GET' && path === '/edits/edit-1/tracks') {
      return { tracks: Object.entries(tracks).map(([track, releases]) => ({ track, releases })) };
    }
    const track = path.match(/^\/edits\/edit-1\/tracks\/(.+)$/)?.[1];
    if (method === 'PUT' && track) return body;
    if (method === 'POST' && path === '/edits/edit-1:commit') return { id: 'edit-1' };
    throw new Error(`Unexpected ${method} ${path}`);
  };
  return { calls, request };
}

const update = (calls) => calls.find((call) => call.method === 'PUT');
const committed = (calls) => calls.some((call) => call.path.endsWith(':commit'));

test('the newest internal build goes to a fraction of production, with its name and note', async () => {
  const play = fakePlay({
    internal: [
      { name: '141 (1.2.0)', versionCodes: ['141'], status: 'completed', releaseNotes: NOTES },
      { name: '142 (1.2.0)', versionCodes: ['142'], status: 'completed', releaseNotes: NOTES },
    ],
  });

  const done = await promote({ request: play.request, versionCode: '', percent: 10 });

  assert.deepEqual(done, { code: '142', from: 'internal', percent: 10, name: '142 (1.2.0)' });
  assert.equal(update(play.calls).path, '/edits/edit-1/tracks/production');
  assert.deepEqual(update(play.calls).body, {
    track: 'production',
    releases: [
      { name: '142 (1.2.0)', versionCodes: ['142'], releaseNotes: NOTES, status: 'inProgress', userFraction: 0.1 },
    ],
  });
  assert.equal(play.calls.at(-1).path, '/edits/edit-1:commit');
});

test('newest is by number, not by text', async () => {
  const play = fakePlay({ internal: [{ versionCodes: ['99'] }, { versionCodes: ['100'] }] });
  assert.equal((await promote({ request: play.request, percent: 5 })).code, '100');
});

test('100 percent is a completed release with no fraction', async () => {
  const play = fakePlay({ internal: [{ name: '142 (1.2.0)', versionCodes: ['142'], releaseNotes: NOTES }] });

  await promote({ request: play.request, versionCode: '142', percent: 100 });

  const [release] = update(play.calls).body.releases;
  assert.equal(release.status, 'completed');
  assert.equal('userFraction' in release, false);
});

test('a rollout under way is widened where it is, not restarted from a testing track', async () => {
  // Listed after internal, which still holds the same build under an older note: the
  // copy on production is the one to carry forward.
  const play = fakePlay({
    internal: [{ name: '142 (1.2.0)', versionCodes: ['142'], releaseNotes: [] }],
    production: [
      { name: '120 (1.1.0)', versionCodes: ['120'], status: 'completed' },
      { name: '142 (1.2.0)', versionCodes: ['142'], status: 'inProgress', userFraction: 0.1, releaseNotes: NOTES },
    ],
  });

  const done = await promote({ request: play.request, versionCode: '142', percent: 50 });

  assert.equal(done.from, 'production');
  assert.deepEqual(update(play.calls).body.releases, [
    { name: '142 (1.2.0)', versionCodes: ['142'], releaseNotes: NOTES, status: 'inProgress', userFraction: 0.5 },
  ]);
});

test('the internal track is found under the name Google documents for it too', async () => {
  const play = fakePlay({ qa: [{ versionCodes: ['142'] }], alpha: [{ versionCodes: ['150'] }] });
  assert.deepEqual(await promote({ request: play.request, percent: 10 }), { code: '142', from: 'qa', percent: 10, name: undefined });
});

test('a build only closed testing has can be promoted', async () => {
  const play = fakePlay({ internal: [{ versionCodes: ['150'] }], alpha: [{ versionCodes: ['142'] }] });
  assert.equal((await promote({ request: play.request, versionCode: '142', percent: 10 })).from, 'alpha');
});

test('a version code no track is serving is refused before anything changes', async () => {
  const play = fakePlay({ internal: [{ versionCodes: ['142'] }] });

  await assert.rejects(promote({ request: play.request, versionCode: '124', percent: 10 }), /No track is serving version code 124.*internal: 142/);
  assert.equal(update(play.calls), undefined);
  assert.equal(committed(play.calls), false);
});

test('a build already released to everyone is refused', async () => {
  const play = fakePlay({ production: [{ versionCodes: ['142'], status: 'completed' }] });

  await assert.rejects(promote({ request: play.request, versionCode: '142', percent: 10 }), /already released/);
  assert.equal(committed(play.calls), false);
});

test('an empty internal track with no version code named is refused', async () => {
  const play = fakePlay({});
  await assert.rejects(promote({ request: play.request, percent: 10 }), /no build to promote/);
});

test('the rollout is a whole percentage from 1 to 100', () => {
  assert.equal(parseRollout('10'), 10);
  assert.equal(parseRollout('100'), 100);
  for (const wrong of ['0', '101', '0.1', '10%', '', 'ten', '-5']) {
    assert.throws(() => parseRollout(wrong), /whole percentage/, wrong);
  }
});

test('the token request is signed by the key and asks only for the Play scope', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = {
    client_email: 'publisher@example.iam.gserviceaccount.com',
    private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };

  const [header, claims, signature] = tokenAssertion(key, 1_700_000_000_000).split('.');

  assert.equal(
    createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url')),
    true,
  );
  assert.deepEqual(JSON.parse(Buffer.from(claims, 'base64url')), {
    iss: 'publisher@example.iam.gserviceaccount.com',
    scope: 'https://www.googleapis.com/auth/androidpublisher',
    aud: 'https://oauth2.googleapis.com/token',
    iat: 1_700_000_000,
    exp: 1_700_000_600,
  });
});

test('calls carry the token, and a refusal from Play names the call and stops', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const key = { client_email: 'publisher@example.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) };
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), init });
    if (String(url) === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'token-1' });
    if (String(url).endsWith('/edits')) return Response.json({ id: 'edit-1' });
    return new Response('{"error":"nope"}', { status: 403 });
  };

  const request = await playClient(key, 'com.example.app', fetchImpl);
  assert.deepEqual(await request('POST', '/edits'), { id: 'edit-1' });
  assert.equal(seen[1].url, 'https://androidpublisher.googleapis.com/androidpublisher/v3/applications/com.example.app/edits');
  assert.equal(seen[1].init.headers.authorization, 'Bearer token-1');

  await assert.rejects(request('GET', '/edits/edit-1/tracks'), /Play refused GET \/edits\/edit-1\/tracks \(403\)/);
});
