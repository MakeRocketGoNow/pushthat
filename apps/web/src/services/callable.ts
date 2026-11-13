import { FunctionsError } from 'firebase/functions';

/**
 * The message a callable's refusal carries, or `fallback` when the SDK has only the
 * bare code: a network failure, a timeout or an uncaught server error leaves
 * `message` as "internal" or "deadline-exceeded", which is nothing to show anyone.
 * A refusal the function threw itself (`HttpsError` with a sentence) comes through
 * whole, colons and all.
 */
export function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof FunctionsError) || !err.message) return fallback;
  const code = err.code.replace(/^functions\//, '');
  const bareCode = err.message.toLowerCase().replace(/_/g, '-') === code;
  return code === 'internal' || bareCode ? fallback : err.message;
}
