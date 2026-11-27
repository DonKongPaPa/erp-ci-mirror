/**
 * `APP_TRUSTED_ORIGINS`: a comma-separated list of complete origins whose cookie-authenticated
 * write requests are trusted when the application is reached through a forwarded domain.
 *
 * A complete origin is `scheme://host[:port]`. Matching stays exact (scheme + host + port): no
 * wildcards, no case folding outside what URL parsing already canonicalizes. An invalid entry is
 * refused at configuration load instead of being silently dropped, so a typo cannot quietly leave
 * the forwarded origin blocked.
 */
const VALID_EXAMPLE = 'https://a.example:13000';

const invalidOrigin = (item: string): Error =>
  new Error(
    `Invalid APP_TRUSTED_ORIGINS entry "${item}": expected a complete origin such as "${VALID_EXAMPLE}" (scheme://host[:port], no path, query, fragment, credentials or wildcard).`,
  );

export function parseTrustedOrigins(value: string): string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      let origin: string;
      try {
        origin = new URL(item).origin;
      } catch {
        throw invalidOrigin(item);
      }
      if (
        origin !== item ||
        !/^https?:\/\//u.test(item) ||
        item.includes('*') ||
        item.includes('?')
      ) {
        throw invalidOrigin(item);
      }
      return item;
    });
}
