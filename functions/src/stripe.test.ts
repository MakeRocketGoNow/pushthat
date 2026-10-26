import { formEncode, inCidrs, signWebhook, stripeOf, verifyWebhookSignature } from './stripe';

describe('stripeOf', () => {
  const all = { STRIPE_SECRET_KEY: 'sk_test_1', STRIPE_WEBHOOK_SECRET: 'whsec_1', STRIPE_PRO_PRICE_ID: 'price_1' };
  test('all three settings turn billing on, and the key says which environment', () => {
    expect(stripeOf(all)).toMatchObject({
      environment: 'test',
      proPriceId: 'price_1',
      apiUrl: 'https://api.stripe.com',
    });
    expect(stripeOf({ ...all, STRIPE_SECRET_KEY: 'rk_live_1' })?.environment).toBe('live');
  });
  test('any missing, and billing is off', () => {
    expect(stripeOf({})).toBeUndefined();
    expect(stripeOf({ ...all, STRIPE_PRO_PRICE_ID: ' ' })).toBeUndefined();
    expect(stripeOf({ ...all, STRIPE_WEBHOOK_SECRET: undefined })).toBeUndefined();
  });
});

describe('formEncode', () => {
  test('nests objects and arrays the way Stripe reads them', () => {
    expect(
      formEncode({
        mode: 'subscription',
        managed_payments: { enabled: true },
        line_items: [{ price: 'p', quantity: 1 }],
        skip: undefined,
        none: null,
      })
    ).toBe(
      'mode=subscription&managed_payments%5Benabled%5D=true&line_items%5B0%5D%5Bprice%5D=p&line_items%5B0%5D%5Bquantity%5D=1'
    );
  });
});

describe('the webhook signature', () => {
  const secret = 'whsec_test';
  const body = '{"id":"evt_1","type":"invoice.paid"}';
  const ts = 1_800_000_000;
  const now = ts * 1000 + 30_000;

  test('a signature made with the secret over the raw body passes', () => {
    expect(verifyWebhookSignature(secret, signWebhook(secret, body, ts), body, now)).toBe(true);
    expect(verifyWebhookSignature(secret, signWebhook(secret, body, ts), Buffer.from(body), now)).toBe(true);
  });
  test('a different body, secret or a re-serialised body fails', () => {
    expect(verifyWebhookSignature(secret, signWebhook(secret, body, ts), body + ' ', now)).toBe(false);
    expect(verifyWebhookSignature('other', signWebhook(secret, body, ts), body, now)).toBe(false);
  });
  test('a replay past five minutes fails', () => {
    expect(verifyWebhookSignature(secret, signWebhook(secret, body, ts), body, now + 6 * 60 * 1000)).toBe(false);
  });
  test('any of several v1 signatures will do, and a missing header fails', () => {
    const rolled = `${signWebhook('old', body, ts)},v1=${signWebhook(secret, body, ts).split('v1=')[1]}`;
    expect(verifyWebhookSignature(secret, rolled, body, now)).toBe(true);
    expect(verifyWebhookSignature(secret, undefined, body, now)).toBe(false);
    expect(verifyWebhookSignature(secret, `t=${ts}`, body, now)).toBe(false);
  });
});

describe('inCidrs', () => {
  test('matches a bare address and a range', () => {
    expect(inCidrs('3.18.12.63', ['3.18.12.63', '13.235.14.0/24'])).toBe(true);
    expect(inCidrs('13.235.14.200', ['13.235.14.0/24'])).toBe(true);
    expect(inCidrs('13.235.15.1', ['13.235.14.0/24'])).toBe(false);
    expect(inCidrs('::1', ['3.18.12.63'])).toBe(false);
  });
});
