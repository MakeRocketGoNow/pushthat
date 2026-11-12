/**
 * What docs/e2ee.md asks of a new password, since the password is the key. Here rather than
 * in services/signIn.ts so the Security page can quote it without importing Firebase, which
 * the build cannot run when it prerenders that page (src/staticPages.tsx).
 */
export const MIN_PASSWORD_LENGTH = 10;
