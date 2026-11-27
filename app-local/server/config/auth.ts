import type { AppConfigFactory } from '@nocobase/app-server/config';
import { apiKey } from '@nocobase/app-plugin-api-keys/server';
import {
  defineAuthConfig,
  type AuthConfig,
} from '@nocobase/app-plugin-authentication/server';
import { bearer, deviceAuthorization, username } from 'better-auth/plugins';

import { ownKeyEndpointGuard } from '../own-key-endpoint-guard.js';
import { parseTrustedOrigins } from './trusted-origins.js';

/**
 * The command-line clients that may sign in through the browser (`deviceAuthorization()`): `nocobase-cli`, the id
 * `@nocobase/app-cli-client` sends unless a branded CLI names its own. Add the id of any other CLI that should sign in.
 */
const CLI_CLIENT_IDS: readonly string[] = ['nocobase-cli'];

// Select a named sender with passwordReset.mailer; defineAuthConfig retains AUTH_EMAIL_* for legacy inline senders.
// Automatic recovery requires passwordReset.enabled: true; leave the switch absent for custom callback compatibility.
const auth: AppConfigFactory<AuthConfig> = defineAuthConfig({
  defaults: (runtime) => ({
    plugins: [
      username({ displayUsername: false }),
      apiKey(),
      // A CLI signs in through the browser (RFC 8628): it shows a code the person approves on `/device`, below the
      // application's base path, and receives a session token it sends as `Authorization: Bearer` (`bearer()`).
      deviceAuthorization({
        verificationUri: '/device',
        expiresIn: '10m',
        interval: '5s',
        validateClient: (clientId) => CLI_CLIENT_IDS.includes(clientId),
      }),
      bearer(),
    ],
    // R-032: the plugin's own policy hook on `/api-key/create` never sees the application's policy, because the
    // configuration pipeline drops the symbol the policy slot hangs from. This application-contributed middleware
    // asks the same question on `/api-key/create` and `/api-key/update`; see `server/own-key-endpoint-guard.ts`.
    hooks: { before: ownKeyEndpointGuard(() => runtime.app) },
    emailAndPassword: { enabled: true, autoSignIn: true },
    session: { storeSessionInDatabase: true },
    account: { encryptOAuthTokens: true },
  }),
  // Cookie-authenticated write requests may arrive from a forwarded domain; the framework compares
  // the request's Origin against publicOrigin plus this list. The parser keeps the list exact and
  // refuses to start on an invalid entry rather than silently trusting nothing.
  env: {
    APP_TRUSTED_ORIGINS: {
      path: 'trustedOrigins',
      description:
        'Comma-separated complete origins of cookie-authenticated write requests to trust when the application is reached through a forwarded domain, such as https://apps.example.com:13000.',
      required: false,
      parse: parseTrustedOrigins,
    },
  },
  // R-032: `hooks.before` cannot be expressed by a configuration file — a user-written `auth.hooks`
  // (even `null` or an empty map) replaces it and silently leaves `/api-key/create` unguarded, and the plugin's
  // own policy hook cannot take over (see `server/own-key-endpoint-guard.ts`). Refuse to start instead.
  validate: (_auth, context) => {
    if (!context.isUserProvided('hooks')) return;
    context.error(
      'hooks',
      "auth.hooks carries the application's own-key guard; it cannot be set from a configuration file.",
    );
  },
});

export default auth;
