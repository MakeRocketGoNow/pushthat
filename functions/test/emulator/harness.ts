import { deleteApp, getApp, getApps, initializeApp } from 'firebase-admin/app';
import { Firestore, Timestamp, getFirestore } from 'firebase-admin/firestore';
import { CallableFunction, CallableRequest } from 'firebase-functions/v2/https';
import { IncomingMessage, Server, ServerResponse, createServer } from 'node:http';
import { AddressInfo } from 'node:net';

import {
  STRIPE_WEBHOOK_IPS_URL,
  StripeCharge,
  StripeInvoice,
  StripeSubscription,
  forgetStripeIps,
  signWebhook,
} from '../../src/stripe';

/**
 * What the emulator suites share: the Firestore emulator, a stand-in for Stripe's API,
 * Stripe's published webhook addresses, and the webhook served over HTTP the way the
 * Functions framework serves it. Run with `npm run test:emulator`, which starts the
 * Firestore emulator under `firebase emulators:exec` and sets `FIRESTORE_EMULATOR_HOST`.
 */

export const PROJECT = 'demo-pushthat';
export const WEBHOOK_SECRET = 'whsec_emulator';
export const PRICE_ID = 'price_pro';
/** The one address the stand-in list of Stripe's webhook senders holds. */
export const STRIPE_IP = '3.18.12.63';

const emulatorHost = process.env.FIRESTORE_EMULATOR_HOST;
if (!emulatorHost) {
  // Without it the Admin SDK would look for a real project, so refuse rather than guess.
  throw new Error('FIRESTORE_EMULATOR_HOST is not set: run these with `npm run test:emulator`.');
}
// The bucket the orphan sweep lists; the Admin SDK sends it to the Storage emulator when
// `FIREBASE_STORAGE_EMULATOR_HOST` is set, as `emulators:exec` does.
export const BUCKET = `${PROJECT}.appspot.com`;
if (getApps().length === 0) initializeApp({ projectId: PROJECT, storageBucket: BUCKET });

export const db = (): Firestore => getFirestore();

/** For a suite's `afterAll`: closes the Firestore client, which otherwise keeps Jest from exiting. */
export const closeFirestore = (): Promise<void> => deleteApp(getApp());

/** Deletes every document in the emulator's database. */
export async function clearFirestore(): Promise<void> {
  const res = await fetch(`http://${emulatorHost}/emulator/v1/projects/${PROJECT}/databases/(default)/documents`, {
    method: 'DELETE',
  });
  if (!res.ok) throw new Error(`clearing the emulator answered ${res.status}`);
}

/** Billing on, against `stripe`. */
export function billingOn(stripe: StripeStandIn): void {
  process.env.STRIPE_SECRET_KEY = 'sk_test_emulator';
  process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
  process.env.STRIPE_PRO_PRICE_ID = PRICE_ID;
  process.env.STRIPE_API_URL = stripe.url;
}

export function billingOff(): void {
  delete process.env.STRIPE_SECRET_KEY;
  delete process.env.STRIPE_WEBHOOK_SECRET;
  delete process.env.STRIPE_PRO_PRICE_ID;
}

// --- Stripe's webhook addresses -----------------------------------------------------------

const realFetch = globalThis.fetch;

/**
 * Answers the fetch of Stripe's published webhook addresses with `STRIPE_IP` alone, so
 * no suite reaches stripe.com; every other fetch goes through as it was.
 */
export function standInForStripeIps(): void {
  forgetStripeIps();
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url === STRIPE_WEBHOOK_IPS_URL) return Response.json({ WEBHOOKS: [STRIPE_IP] });
    return realFetch(input, init);
  }) as typeof fetch;
}

export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}

// --- A stand-in for Stripe's API ----------------------------------------------------------

export interface StripeRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  form: URLSearchParams;
  headers: IncomingMessage['headers'];
}

export type StripeAnswer = { status?: number; body: unknown };
type Route = (req: StripeRequest) => StripeAnswer;

/**
 * Stripe's API as the functions call it, over HTTP on a local port, so `stripeCall`'s
 * own form encoding, headers and error handling are what is exercised. Routes are
 * `METHOD /path` without the query; a request no route answers is Stripe's 404. Every
 * request is kept, for the suites to say what was asked.
 */
export class StripeStandIn {
  readonly requests: StripeRequest[] = [];
  private routes = new Map<string, Route>();
  private server: Server | null = null;
  url = '';

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  reset(): void {
    this.requests.length = 0;
    this.routes.clear();
    // Asked of every new subscription by the webhook and of every checkout.
    this.route('GET /v1/checkout/sessions', () => ({ body: list([]) }));
  }

  /** Answers `key` with what `answer` returns, or always with `body`. */
  route(key: string, answer: Route): void;
  route(key: string, body: object): void;
  route(key: string, answer: Route | object): void {
    this.routes.set(key, typeof answer === 'function' ? (answer as Route) : () => ({ body: answer }));
  }

  /** The requests made to `key` (`METHOD /path`). */
  made(key: string): StripeRequest[] {
    return this.requests.filter((r) => `${r.method} ${r.path}` === key);
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://stripe.test');
      const request: StripeRequest = {
        method: req.method ?? 'GET',
        path: url.pathname,
        query: url.searchParams,
        form: new URLSearchParams(Buffer.concat(chunks).toString('utf8')),
        headers: req.headers,
      };
      this.requests.push(request);
      const route = this.routes.get(`${request.method} ${request.path}`);
      const answer = route
        ? route(request)
        : {
            status: 404,
            body: { error: { type: 'invalid_request_error', code: 'resource_missing', message: 'No such route' } },
          };
      res.writeHead(answer.status ?? 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(answer.body));
    });
  }
}

export function list<T>(data: T[]): { object: 'list'; data: T[]; has_more: false } {
  return { object: 'list', data, has_more: false };
}

export function stripeRefusal(status: number, message: string): StripeAnswer {
  return { status, body: { error: { type: 'invalid_request_error', message } } };
}

// --- The webhook over HTTP ------------------------------------------------------------------

type Handler = (req: unknown, res: unknown) => unknown;

/**
 * Serves an `onRequest` function on a local port with what the Functions framework adds
 * to Node's request and response: `rawBody`, `ip`, `status()` and `json()`.
 */
export async function serve(fn: Handler): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      Object.assign(req, { rawBody: Buffer.concat(chunks), ip: req.socket.remoteAddress });
      Object.assign(res, {
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        json(body: unknown) {
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(body));
          return res;
        },
      });
      Promise.resolve(fn(req, res)).catch((err: Error) => {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: err.message }));
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Posts `event` to the webhook at `url`, signed and from Stripe's address unless told otherwise. */
export async function deliver(
  url: string,
  event: unknown,
  opts: { raw?: string; signature?: string; address?: string; method?: string } = {}
): Promise<{ status: number; body: Record<string, unknown> }> {
  const raw = opts.raw ?? JSON.stringify(event);
  const res = await fetch(url, {
    method: opts.method ?? 'POST',
    headers: {
      'content-type': 'application/json',
      'stripe-signature': opts.signature ?? signWebhook(WEBHOOK_SECRET, raw, Math.floor(Date.now() / 1000)),
      'x-forwarded-for': opts.address ?? STRIPE_IP,
    },
    ...(opts.method && opts.method !== 'POST' ? {} : { body: raw }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

// --- Callables ------------------------------------------------------------------------------

/** Calls an `onCall` function as the signed-in `uid`, or signed out with `uid` null. */
export function call<T>(fn: CallableFunction<unknown, Promise<T>>, uid: string | null, data: unknown = {}): Promise<T> {
  const request = {
    data,
    rawRequest: {},
    acceptsStreaming: false,
    ...(uid ? { auth: { uid, token: { uid, email: `${uid}@example.com` }, rawToken: 'token' } } : {}),
  } as unknown as CallableRequest<unknown>;
  return fn.run(request) as Promise<T>;
}

// --- Stripe's objects -----------------------------------------------------------------------

// Typed against the client's own shapes, so a field renamed in `src/stripe.ts` stops these
// suites compiling rather than letting them go on sending the old shape.

export const DAY = 24 * 60 * 60;
export const YEAR = 365 * DAY;

export function subscription(
  id: string,
  opts: {
    customer?: string;
    status?: string;
    created: number;
    periodStart?: number;
    periodEnd?: number;
    canceledAt?: number | null;
    latestInvoice?: string | StripeInvoice | null;
  }
): StripeSubscription & { object: 'subscription' } {
  const periodStart = opts.periodStart ?? opts.created;
  return {
    id,
    object: 'subscription',
    status: opts.status ?? 'active',
    customer: opts.customer ?? 'cus_1',
    created: opts.created,
    cancel_at: null,
    cancel_at_period_end: false,
    canceled_at: opts.canceledAt ?? null,
    metadata: {},
    items: list([
      {
        id: `si_${id}`,
        price: { id: PRICE_ID },
        quantity: 1,
        current_period_start: periodStart,
        current_period_end: opts.periodEnd ?? periodStart + YEAR,
      },
    ]),
    ...(opts.latestInvoice !== undefined ? { latest_invoice: opts.latestInvoice } : {}),
  };
}

export function invoice(
  id: string,
  opts: { subscription: string; customer?: string; periodStart: number; periodEnd?: number; status?: string }
): StripeInvoice & { object: 'invoice' } {
  return {
    id,
    object: 'invoice',
    customer: opts.customer ?? 'cus_1',
    status: opts.status ?? 'paid',
    parent: { type: 'subscription_details', subscription_details: { subscription: opts.subscription } },
    lines: list([
      {
        id: `il_${id}`,
        amount: 2400,
        quantity: 1,
        pricing: { price_details: { price: PRICE_ID } },
        period: { start: opts.periodStart, end: opts.periodEnd ?? opts.periodStart + YEAR },
      },
    ]),
  };
}

export function charge(
  id: string,
  opts: { customer?: string; paymentIntent: string; refunded?: number }
): StripeCharge & { object: 'charge' } {
  return {
    id,
    object: 'charge',
    amount: 2400,
    amount_refunded: opts.refunded ?? 2400,
    refunded: (opts.refunded ?? 2400) >= 2400,
    payment_intent: opts.paymentIntent,
    customer: opts.customer ?? 'cus_1',
  };
}

let eventCount = 0;

export function event(type: string, object: unknown, created: number, id = `evt_${++eventCount}`) {
  return { id, object: 'event', type, created, data: { object } };
}

/** A user document holding `customerId`, and the mapping the webhook finds it by. */
export async function seedCustomer(uid: string, customerId: string, fields: Record<string, unknown> = {}) {
  const batch = db().batch();
  batch.set(db().collection('users').doc(uid), { ...fields, billing: { customerId, ...(fields.billing ?? {}) } });
  batch.set(db().collection('stripeCustomers').doc(customerId), { userId: uid, createdAt: new Date() });
  await batch.commit();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the suites read nested fields freely
export async function userDoc(uid: string): Promise<Record<string, any>> {
  return (await db().collection('users').doc(uid).get()).data() ?? {};
}

export const millisOf = (t: unknown): number | null => (t instanceof Timestamp ? t.toMillis() : null);
/** Unix seconds as milliseconds, the unit Firestore timestamps and `Date` take. */
export const msOf = (unixSeconds: number): number => unixSeconds * 1000;
