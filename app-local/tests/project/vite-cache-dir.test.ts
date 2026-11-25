import path from 'node:path';
import { resolveConfig } from 'vite';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { viteCacheDir } from '../../vite.config';

const appRoot = path.resolve(import.meta.dirname, '../..');

afterEach(() => vi.unstubAllEnvs());

/**
 * An isolated worktree links `app-local/node_modules` to the main checkout's, so Vite's default `node_modules/.vite` is
 * one cache shared by every checkout: whichever checkout starts a dev server replaces it, the main dev server's in-memory
 * version hashes no longer match the files on disk, one package is loaded twice, and lazily loaded routes all fail with
 * "cannot load route" (2026-11-25). The cache must therefore be per checkout, and it must stay inside the ignored
 * `node_modules`.
 *
 * Asserting the resolved config, not the file text: this is the directory the dependency optimizer actually uses.
 */
describe('Vite 缓存每个检出各一份', () => {
  it('缓存目录跟着检出的路径走，落在被忽略的 node_modules 里', async () => {
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

    expect(config.cacheDir).toBe(viteCacheDir(appRoot));
    expect(path.dirname(config.cacheDir)).toBe(
      path.join(appRoot, 'node_modules'),
    );
    expect(path.basename(config.cacheDir)).toMatch(/^\.vite-[0-9a-f]{8}$/);
  });

  it('两个不同的检出不会落到同一个目录，同一个检出每次都一样', () => {
    const one = viteCacheDir('/tmp/hs-wt-one/app-local');
    const two = viteCacheDir('/tmp/hs-wt-two/app-local');

    expect(one).not.toBe(two);
    expect(viteCacheDir('/tmp/hs-wt-one/app-local')).toBe(one);
  });
});
