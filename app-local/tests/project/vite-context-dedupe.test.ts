import path from 'node:path';
import { resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';

const appRoot = path.resolve(import.meta.dirname, '../..');

afterEach(() => vi.unstubAllEnvs());

/**
 * The application shell and the pages it renders through plugins share React contexts: `useService` /
 * `useClientApplication` (app-client), `useTranslation` (i18n) and `useCan` / `useAuthorizationClient`
 * (authorization). pnpm can install more than one physical copy of a package when peer dependencies resolve
 * differently; a page built from another copy reads a different context and fails as if it were rendered outside the
 * shell (`useClientApplication() must be used inside AppClientRoot`). Vite must resolve these from this application.
 *
 * Asserting the resolved config, not the file text: this is the value the dependency optimizer and the build use.
 */
describe('one copy of the client context packages', () => {
  it('dedupes the framework packages whose contexts plugin pages share with the shell', async () => {
    // `pnpm dev` passes the mount path; the preset refuses to serve without one.
    vi.stubEnv('APP_BASE_PATH', '/main');
    const config = await resolveConfig(
      {
        configFile: path.join(appRoot, 'vite.config.ts'),
        root: appRoot,
        logLevel: 'silent',
      },
      'serve',
    );

    expect(config.resolve.dedupe).toEqual(
      expect.arrayContaining([
        'react',
        'react-dom',
        'react-router',
        '@nocobase/app-client',
        '@nocobase/i18n',
        '@nocobase/app-plugin-authorization',
      ]),
    );
  });
});
