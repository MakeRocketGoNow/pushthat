// Sealing a URL push within `enc.ct`'s bound (src/services/urlEnvelope.ts): the icon goes in
// when there is one and it fits, and is dropped rather than the push refused when it does
// not. Run by `npm run test:keys`, in plain Node, with a stand-in for the cipher whose
// output is as long as the JSON it is given.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { MAX_CT_LENGTH, sealUrlEnvelope } from '../src/services/urlEnvelope.ts';

const sealed = [];
const seal = async (envelope) => {
  sealed.push(envelope);
  return { v: 1, n: '', ct: JSON.stringify(envelope) };
};
const envelopeOf = (urlLength) => ({ url: `https://example.com/${'a'.repeat(urlLength)}`, title: '', ext: '' });
// The JSON's length with nothing but the URL's tail: what is left of the bound is the tail.
const overhead = JSON.stringify(envelopeOf(0)).length;
const icon = 'A'.repeat(5464);

describe('sealUrlEnvelope', () => {
  test('seals without an icon the same envelope as before icons', async () => {
    sealed.length = 0;
    const enc = await sealUrlEnvelope(seal, envelopeOf(10));
    assert.deepEqual(JSON.parse(enc.ct), envelopeOf(10));
    assert.equal(sealed.length, 1);
  });

  test('puts the icon in when it fits', async () => {
    const enc = await sealUrlEnvelope(seal, envelopeOf(10), icon);
    assert.equal(JSON.parse(enc.ct).icon, icon);
  });

  test('drops the icon rather than the push when only the icon does not fit', async () => {
    const envelope = envelopeOf(MAX_CT_LENGTH - overhead - 100);
    const enc = await sealUrlEnvelope(seal, envelope, icon);
    assert.deepEqual(JSON.parse(enc.ct), envelope);
  });

  test('refuses a push that does not fit even without the icon', async () => {
    assert.equal(await sealUrlEnvelope(seal, envelopeOf(MAX_CT_LENGTH), icon), undefined);
    assert.equal(await sealUrlEnvelope(seal, envelopeOf(MAX_CT_LENGTH)), undefined);
  });

  test('takes one exactly at the bound', async () => {
    const envelope = envelopeOf(MAX_CT_LENGTH - overhead);
    assert.equal((await sealUrlEnvelope(seal, envelope)).ct.length, MAX_CT_LENGTH);
  });
});
