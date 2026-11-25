import { createAppViteConfig } from '@nocobase/dev-config/vite/app';
import { loadAppVitePlugins } from '@nocobase/dev-config/vite/plugins';
import path from 'path';
import {
  createDevClientConfigPlugin,
  createDevProxy,
} from '@nocobase/app-cli/dev/proxy';
import { createHash } from 'node:crypto';

const numberFromEnv = (value: string | undefined): number | undefined => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
};

/**
 * 这个检出自用的 Vite 缓存目录：预构建的依赖与 vitest 的结果缓存都在里面。
 *
 * 隔离副本的 `app-local/node_modules` 链到主检出的那一份，Vite 默认的 `node_modules/.vite` 就成了共用的一份 ——
 * 哪个副本起了开发服务器，缓存被它整份换掉，主开发服务器内存里的版本哈希对不上磁盘，同一个包被加载两份，
 * 懒加载的页面全部「无法加载路由」（2026-11-25）。按检出的路径分开，互不覆盖；仍然落在被忽略的 `node_modules` 里，不入库。
 */
export const viteCacheDir = (root: string): string =>
  path.join(
    root,
    'node_modules',
    `.vite-${createHash('sha1').update(root).digest('hex').slice(0, 8)}`,
  );

// https://vite.dev/config/
export default createAppViteConfig(async (environment) => {
  const command = environment.command;
  // Configuration is loaded by the application runtime. Vite should only
  // consume the environment explicitly supplied by the invoking process;
  // reading .env here would make the client and server use different paths.
  const env = process.env;
  // `pnpm dev` passes the mount path it resolved; the preset serves from it, and a build does not depend on one.
  const appBase = env.APP_BASE_PATH ?? '';
  const devClientConfig =
    command === 'serve'
      ? createDevClientConfigPlugin(appBase, env.PROXY_TARGET_URL)
      : undefined;
  const viteHmrHost = env.APP_VITE_HMR_HOST;
  const viteDevPort = numberFromEnv(env.APP_VITE_DEV_PORT) ?? 5173;

  return {
    root: __dirname,
    // 每个检出各一份缓存：隔离副本与本检出共用 node_modules，默认的缓存目录会互相覆盖（见上面的 viteCacheDir）。
    cacheDir: viteCacheDir(__dirname),
    ...(command === 'build' ? { base: env.CDN_BASE_URL?.trim() || './' } : {}),
    plugins: [
      ...(await loadAppVitePlugins({ appRoot: __dirname, environment })),
      ...(devClientConfig ? [devClientConfig] : []),
    ],
    server: {
      proxy:
        command === 'serve'
          ? createDevProxy(appBase, env.PROXY_TARGET_URL)
          : undefined,
      watch: {
        ignored: [
          '**/storage/**',
          // Vite only excludes dist/client automatically. The server build and
          // vendored packages also live in dist and can exhaust file watchers.
          // Scope this to the app so linked dependencies still receive HMR.
          (filePath: string) => {
            const relativePath = path.relative(__dirname, filePath);
            return (
              relativePath === 'dist' ||
              relativePath.startsWith(`dist${path.sep}`)
            );
          },
        ],
      },
      ...(command === 'serve'
        ? {
            hmr: {
              ...(viteHmrHost ? { host: viteHmrHost } : {}),
              clientPort: viteDevPort,
            },
          }
        : {}),
    },
    resolve: {
      // The framework packages below carry React contexts the application shell and plugin pages share: `useService`
      // (app-client), `useTranslation` (i18n) and `useCan` (authorization). pnpm may install more than one physical
      // copy of a package when peer dependencies resolve differently; resolving each from this application keeps a
      // page and the shell that renders it on the same context, or the page reads an absent one as if it were
      // rendered outside the shell (`useClientApplication() must be used inside AppClientRoot`).
      dedupe: [
        'react',
        'react-dom',
        'react-router',
        '@nocobase/app-client',
        '@nocobase/i18n',
        '@nocobase/app-plugin-authorization',
      ],
    },
  };
});
