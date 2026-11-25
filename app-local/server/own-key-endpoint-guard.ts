import { authenticationToken } from '@nocobase/app-plugin-authentication/server';
import { isApiKeySession } from '@nocobase/app-plugin-api-keys/server';
import type { Application } from '@nocobase/app-server/application';
import {
  createServiceToken,
  type ServiceToken,
} from '@nocobase/service-provider';
import { APIError, createAuthMiddleware } from 'better-auth/api';

/**
 * Better Auth 的端点路径与各自的拒绝码。路径是插件注册的路径，不含挂载点：钩子里读到的
 * `ctx.path` 就是它，与框架自己的钩子读到的一致。
 */
const REFUSED_PATHS: Readonly<
  Record<string, { readonly code: string; readonly message: string }>
> = {
  '/api-key/create': {
    code: 'API_KEY_CREATION_FORBIDDEN',
    message: 'You may not create API keys of your own.',
  },
  // 改有效期与重新启用走这一个端点：对 R-032 来说与创建、轮换同一类动作。
  '/api-key/update': {
    code: 'API_KEY_UPDATE_FORBIDDEN',
    message: 'You may not update API keys of your own.',
  },
};

/** 「是不是 root」的判定，由 `ApiKeysPolicyProvider` 装策略时登记。 */
export type OwnKeyPolicyCheck = (userId: string) => Promise<boolean>;

/**
 * 守卫靠这个登记判断策略在不在。没登记就拒绝，而不是拿 `ScopedApiKeys.mayCreateOwn` 的默认
 * `true`——那是给根本没有策略的应用的。
 */
export const ownKeyPolicyToken: ServiceToken<OwnKeyPolicyCheck> =
  createServiceToken<OwnKeyPolicyCheck>('app/own-key-policy');

/**
 * R-032：同一个密钥插件挂在 Better Auth 下的端点上，补上「创建与更新收紧到 root」。
 *
 * 框架自己的钩子在这个应用里不生效：「谁可以建自己的密钥」这个策略槽挂在插件对象的一个
 * 不可枚举 symbol 上（`app-plugin-api-keys` 的 `OWN_KEY_POLICY_SLOT`），而配置管道每次读取
 * 都按 `Object.entries` 克隆对象（`@nocobase/config` 的 `cloneConfigValue`），symbol 属性被
 * 丢掉。`connectOwnKeyPolicy` 于是在 `auth.administrationContext()` 的插件列表里找不到槽，
 * `POST /api/auth/api-key/create` 的钩子读到的策略是空、直接放行。`/api/apiKeys` 不受影响：
 * 它读的是服务内部的 `ScopedApiKeys`，策略就在里面。
 *
 * 这道守卫是应用贡献给 Better Auth 的 `hooks.before`：它与框架自己的钩子在同一条链上，排
 * 在它们前面，不依赖路由的挂载顺序。它管两条端点——创建与更新（改有效期、重新启用）。
 * 列出、读取、吊销不管：丢了创建权限的人仍然要能清理自己已有的密钥。
 *
 * 会话要经框架的 `Auth.getSession()` 读：只有它会按已配置的插件把凭据换成人。光看
 * `ctx.context.session` 不够——`Authorization: Bearer <会话令牌>` 是 bearer 插件自己的
 * `hooks.before` 换算成会话 cookie 的，而应用的钩子排在插件钩子前面，那时还没有会话；设备
 * 授权（`/device/token`）换来的令牌走的也是这条路。
 *
 * @param resolveApp 请求到达时把应用交出来；配置工厂跑的时候应用还没建好。
 */
export function ownKeyEndpointGuard(resolveApp: () => Application | undefined) {
  return createAuthMiddleware(async (ctx) => {
    const refusal = REFUSED_PATHS[ctx.path];
    if (!refusal) return;
    // 服务端调用（`auth.api.*`）压根没有请求头：没有「谁的会话」要收紧，由调用方授权。
    if (!ctx.headers) return;
    const headers = ctx.headers;
    const app = resolveApp();
    const session = await sessionOf(headers, app);
    if (!session) {
      // 没有任何会话凭据：匿名请求，端点的 401 就是它的回答。
      if (!presentsSession(headers)) return;
      // 带了凭据却读不出会话：拿不准，按「是用户会话」处理，不放行。
      throw APIError.from('UNAUTHORIZED', {
        code: 'API_KEY_SESSION_UNVERIFIED',
        message:
          'The session could not be verified, so the request is refused.',
      });
    }
    // 密钥换来的会话：所有 /api-key/* 都由框架的钩子拒（API_KEY_SESSION_FORBIDDEN），让给它，
    // 免得这里换成一个别的错误码。
    if (isApiKeySession(session, headers)) return;
    const check = policyCheckOf(app);
    if (!check) throw policyUnavailable();
    let mayCreate: boolean;
    try {
      mayCreate = await check(session.user.id);
    } catch (error) {
      // 判定不出来就不放行：宁可这次请求失败，也不默认它可以建密钥。
      throw policyUnavailable(error);
    }
    if (mayCreate) return;
    throw APIError.from('FORBIDDEN', refusal);
  });
}

/**
 * 请求的会话，按框架认得的凭据读：会话 cookie、`Authorization: Bearer`（bearer 插件）、设备的
 * 令牌，以及密钥。`disableCookieCache` 让判定落在库里的会话状态上，`disableRefresh` 不在一次
 * 判定里改过期时间。
 *
 * 读不到就是读不到，不退回 `getSessionFromCtx`：那条退路比框架宽松——它不查「用户被禁用」，
 * 绕过 bearer 插件对请求头的改写，还会把读到的会话写进 `ctx.context.session`，让端点自己那次
 * 「禁用缓存、读库」的校验被跳过。cookie 缓存打开时，注销后的旧 cookie、或带着垃圾 Bearer 的
 * 有效 cookie，都会因此被放过去建密钥。
 */
async function sessionOf(headers: Headers, app: Application | undefined) {
  const auth = app?.container.has(authenticationToken)
    ? app.container.resolve(authenticationToken)
    : undefined;
  if (!auth) return null;
  return auth.getSession(headers, {
    disableRefresh: true,
    disableCookieCache: true,
  });
}

/** 会话凭据：浏览器 cookie 或 `Authorization` 头。密钥头不算——它由框架的钩子管。 */
function presentsSession(headers: Headers): boolean {
  return Boolean(headers.get('cookie') || headers.get('authorization'));
}

function policyCheckOf(
  app: Application | undefined,
): OwnKeyPolicyCheck | undefined {
  return app?.container.has(ownKeyPolicyToken)
    ? app.container.resolve(ownKeyPolicyToken)
    : undefined;
}

/** 500：这次请求的「是不是 root」判定不了，按拒绝处理。 */
function policyUnavailable(cause?: unknown): APIError {
  return APIError.from(
    'INTERNAL_SERVER_ERROR',
    {
      code: 'API_KEY_POLICY_UNAVAILABLE',
      message:
        'The API key policy is not available, so the request is refused.',
    },
    cause === undefined ? undefined : { cause },
  );
}
