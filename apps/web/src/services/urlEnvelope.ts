// Sealing a URL push's envelope within `enc.ct`'s bound. Apart from pushes.ts, which needs
// Firebase, so that `npm run test:keys` checks it in plain Node.
import type { Enc, UrlEnvelope } from './e2ee.ts';

// `enc.ct`'s bound in the rules: about 12 KB of JSON, which only an absurd URL reaches. Said
// here, where the reason can be given, rather than as a refusal nobody can explain.
export const MAX_CT_LENGTH = 16384;

/**
 * `envelope` sealed by `seal`, with `icon` when there is one and it fits, or undefined when
 * the envelope does not fit even without it. The icon is written only when there is one, so
 * a push without it seals the same bytes as before, and it is dropped when the envelope with
 * it would not fit: the link matters more than its picture, as when the phones write one back.
 */
export async function sealUrlEnvelope(
  seal: (envelope: UrlEnvelope) => Promise<Enc>,
  envelope: UrlEnvelope,
  icon?: string
): Promise<Enc | undefined> {
  if (icon) {
    const withIcon = await seal({ ...envelope, icon });
    if (withIcon.ct.length <= MAX_CT_LENGTH) return withIcon;
  }
  const enc = await seal(envelope);
  return enc.ct.length <= MAX_CT_LENGTH ? enc : undefined;
}
