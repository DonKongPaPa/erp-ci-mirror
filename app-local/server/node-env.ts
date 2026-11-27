/**
 * `NODE_ENV` 是不是开发环境。生产常驻：开发工具的登记入口（`server/embedded.ts`）与启动守卫
 * （`server/providers/dev-tools-guard.ts`）共用这一个判定，两处不会给出不同的答案。
 */

/** 框架把 `develop` 与 `development` 当作开发环境（`@nocobase/app-server` 的 jobs provider）。 */
const DEVELOPMENT_ENVIRONMENTS: readonly string[] = ['develop', 'development'];

/** 缺失的环境标记按生产对待：手工组装的应用可能不带它，拿不准就当它是最严的那一档。 */
export function isDevelopmentNodeEnv(nodeEnv: string | undefined): boolean {
  return nodeEnv !== undefined && DEVELOPMENT_ENVIRONMENTS.includes(nodeEnv);
}
