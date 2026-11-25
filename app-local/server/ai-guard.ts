import {
  authenticationToken,
  type AuthEnv,
  type AuthSession,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization';
import type { Application } from '@nocobase/app-server/application';
import { loggingToken } from '@nocobase/app-server/logging';
import {
  ApiError,
  apiErrorHandler,
  defineHttpMiddleware,
} from '@nocobase/app-server/router';
import type { Context } from 'hono';

/**
 * R-045：AI 插件挂在 `/api/agents/*` 下的接口，补一道「与 AI 无关的人不能进」的底线。
 *
 * 插件自己的细粒度检查都在（要哪一项设置项的哪个动作、按人过滤、按机器权限脱敏），缺的只是
 * 「任何登录用户直接调接口都畅通」。这个守卫补那一道底线，并补框架漏掉的两处：
 *
 * 1. 底线：凭用户会话调这一段，没有任何 AI 授权（四个页面的 access、四个设置项的任一动作）
 *    → 403 `AI_ACCESS_REQUIRED`。持一项就放行，剩下的交给各接口自己的检查。
 * 2. 发注册令牌（`POST /agents/runners/registrationTokens`）要 `agents.runners` 的 manage，
 *    否则 403 `RUNNER_REGISTRATION_FORBIDDEN`，不产生令牌行。
 * 3. 把一台机器改成「团队」（`PATCH /agents/runners/:runnerId` 且 `trust` 是 `team`）要同一项
 *    manage，否则 403 `RUNNER_TRUST_FORBIDDEN`，库里的信任级别不变。框架在发令牌时查了项权限，
 *    在改信任级别时漏了：主人可以先发「只跑本人的活」的令牌注册，再把自己的机器改成团队，
 *    进入接所有人活的池子、领到别人的运行。收紧它等于把「让一台机器进来」整件事收到同一项权限。
 *
 * **判据是「这次请求是不是凭用户会话来的」，不是路径白名单。** 凭机器或匿名凭据来的请求
 * （机器协议、运行令牌、注册令牌、公开的安装脚本的匿名取用）不受这三条约束：插件以后加一条
 * 机器协议，天然不受影响；按路径列白名单则会漏。
 *
 * 守卫挂在所有路由之前（`app.addHttpMiddleware`）：应用自己的路由拦不住框架的路由，框架在
 * `addRuntimeContributions` 里先入、应用路由后入，Hono 先匹配先应答。
 *
 * 「凭用户会话」怎么认：应用级 HTTP 中间件跑在各路由的认证中间件之前，请求上下文里还没有
 * `auth`（那是 `authentication.required()` / `optional()` 在各自路由里设置的）。所以守卫用
 * 认证插件自己的 `getSession()` 解析一次请求的凭据形态，写法与应用里既有的一处相同
 * （`server/providers/submission.ts` 的幂等收据要「是谁」时也这样取）。`getSession()` 先问
 * 各插件登记的凭据解析器，再问会话：运行令牌回来时带 `credential`，是机器；cookie 与能换算
 * 成会话的密钥回来时没有 `credential`，是人；runner key、注册令牌它不认识，回来是空。
 * 带 `credential` 的是机器与运行的凭据，放行交给路由自己的检查；只有「人的会话」才过这三条规则。
 *
 * 放行的条件取严：**只有确实不是用户会话的请求才放行** —— 匿名（没有任何用户凭据）、runner key、
 * 运行令牌、注册令牌。带着用户凭据（会话 cookie、Bearer 会话令牌、API 密钥）却解析不出会话的
 * （过期、被拒、或是认证插件认不出的另一种形态），按用户会话处理、不放行：认证可能在我们之后
 * 才把它换算成会话，放过去就等于绕开了这三条规则。拿不到认证或授权服务的实例同样拒绝，不放行。
 *
 * 被拒的请求记一条安全日志：方法、路径、调用方类别、原因码。不记请求体，也不记 cookie 与密钥头。
 */

const DOMAIN = 'aiGuard';

const AI_ACCESS_MESSAGE =
  'This AI endpoint needs at least one AI grant: a page (agents, runtimes, skills or usage), or a settings action on agents.agents, agents.runners, agents.prices or agents.services.';

/** 插件自己的八项资源、十二个动作。有效权限按主体算，`authenticated` 的公共授予也在内。 */
const AI_GRANTS = [
  { resource: { type: 'page', id: 'agents' }, action: 'access' },
  { resource: { type: 'page', id: 'runtimes' }, action: 'access' },
  { resource: { type: 'page', id: 'skills' }, action: 'access' },
  { resource: { type: 'page', id: 'usage' }, action: 'access' },
  { resource: { type: 'settings', id: 'agents.agents' }, action: 'read' },
  { resource: { type: 'settings', id: 'agents.agents' }, action: 'manage' },
  { resource: { type: 'settings', id: 'agents.runners' }, action: 'read' },
  { resource: { type: 'settings', id: 'agents.runners' }, action: 'manage' },
  { resource: { type: 'settings', id: 'agents.prices' }, action: 'read' },
  { resource: { type: 'settings', id: 'agents.prices' }, action: 'manage' },
  { resource: { type: 'settings', id: 'agents.services' }, action: 'read' },
  { resource: { type: 'settings', id: 'agents.services' }, action: 'manage' },
] as const;

/** 可能代表「某个人的会话」的请求头：会话 cookie、Bearer 会话令牌、API 密钥。 */
const USER_CREDENTIAL_HEADERS = [
  'cookie',
  'authorization',
  'x-api-key',
] as const;

function carriesUserCredential(headers: Headers): boolean {
  return USER_CREDENTIAL_HEADERS.some((name) => {
    const value = headers.get(name);
    return value !== null && value.trim() !== '';
  });
}

/** 规则 2、3 都要的那一项。 */
const RUNNERS_MANAGE = {
  resource: { type: 'settings', id: 'agents.runners' },
  action: 'manage',
} as const;

/** 插件那一段接口。带不带尾斜杠、多几个斜杠、点段都先规范化再比。 */
const AGENTS_PREFIX = '/api/agents';
const REGISTRATION_TOKENS = '/api/agents/runners/registrationTokens';
const RUNNER = /^\/api\/agents\/runners\/([^/]+)$/u;

/**
 * 请求路径规范化：消掉连续斜杠与 `.` / `..` 段，再去掉尾斜杠。
 *
 * 挡的是「换个写法绕过前缀判断」：`/api/agents`、`/api/agents/`、`/api/agents//x`、
 * `/api/agents/./x` 都要落到同一个判定上。查询串本就不在 `context.req.path` 里。
 */
function normalizePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return `/${segments.join('/')}`;
}

/** `normalized === AGENTS_PREFIX` 或 `normalized` 以 `AGENTS_PREFIX + '/'` 开头：段边界，不是字符串前缀。 */
function isAgentsPath(normalized: string): boolean {
  return (
    normalized === AGENTS_PREFIX || normalized.startsWith(`${AGENTS_PREFIX}/`)
  );
}

/**
 * 规则 3 要读请求体里的 `trust`。读的是副本，不动原请求；读不出来（不是 JSON、还没读完）
 * 就当没有这一项，交给路由自己的参数校验。只在 PATCH 一台机器时才读。
 */
async function requestedTrust(context: Context): Promise<unknown> {
  try {
    return ((await context.req.raw.clone().json()) as { trust?: unknown })
      .trust;
  } catch {
    return undefined;
  }
}

export const aiGuardHttpMiddleware = defineHttpMiddleware<Application>({
  name: '@nocobase/app-local/ai-guard',
  register(router, app) {
    // 认证与授权插件都不在的运行时（`tests/server/app-server.test.ts` 起的那种最小应用）
    // 没有 `/api/agents` 这一段：Agent 插件自己的路由就依赖这两个插件。这里不在启动时抛
    // （那会让那种最小应用起不来），但缺任一个都不放行：拿不到会话服务就无法证明请求
    // 不是一个人的会话，按拒绝处理。
    const authentication = app.container.has(authenticationToken)
      ? app.container.resolve(authenticationToken)
      : undefined;
    const authorization = app.container.has(authorizationToken)
      ? app.container.resolve(authorizationToken)
      : undefined;
    const logger = app.container.has(loggingToken)
      ? app.container.resolve(loggingToken).getLogger('security')
      : undefined;

    const deny = (
      context: Context,
      caller: 'session' | 'unidentified',
      reason: string,
      message: string,
    ): Response => {
      const path = normalizePath(context.req.path);
      logger?.info(
        {
          event: 'ai.guard.denied',
          method: context.req.method,
          path,
          caller,
          reason,
        },
        'The AI guard refused an AI endpoint request.',
      );
      return apiErrorHandler(
        new ApiError({
          status: 'PERMISSION_DENIED',
          reason,
          domain: DOMAIN,
          message,
        }),
        context,
      );
    };

    router.use('*', async (rawContext, next) => {
      const context = rawContext as unknown as Context<
        AuthEnv & AuthorizationEnv
      >;
      const path = normalizePath(context.req.path);
      // 不按路径模式挂中间件：`/api/agents//x` 这类形态匹配不上 `use('/api/agents/*')`，
      // 先规范化再判，才能让所有写法落到同一个决定上。
      if (!isAgentsPath(path)) {
        await next();
        return;
      }

      // 认不出请求的凭据形态就不放行：拿不到认证或授权服务的实例时，无法证明它不是一个人的
      // 会话，按拒绝处理（装配完整的应用不会走到这里，见 `register` 里的说明）。
      if (!authentication || !authorization) {
        return deny(
          context,
          'unidentified',
          'AI_ACCESS_REQUIRED',
          AI_ACCESS_MESSAGE,
        );
      }

      // 这次请求是什么凭据。应用级 HTTP 中间件跑在各路由的认证中间件之前，请求上下文里还没有
      // `auth`，所以守卫自己解析一次（照 `server/providers/submission.ts` 的写法）。
      const headers = context.req.raw.headers;
      let auth: AuthSession = null;
      try {
        auth =
          context.get('auth') ??
          (await authentication.getSession(headers, {
            disableRefresh: true,
            disableCookieCache: true,
          }));
      } catch {
        // 凭据被拒：`auth` 保持空，下面按「认不出」处理，不放行。
      }
      if (!auth || auth.credential) {
        // 机器与运行的凭据（运行令牌、在线 agent）带 `credential`，匿名没有任何用户凭据：
        // 这两种确实不是用户会话，交给路由自己的检查。其余（带着用户凭据却解析不出会话）
        // 按用户会话处理、不放行 —— 认证可能在我们之后才把它换算成会话。
        if (carriesUserCredential(headers)) {
          return deny(
            context,
            'unidentified',
            'AI_ACCESS_REQUIRED',
            AI_ACCESS_MESSAGE,
          );
        }
        await next();
        return;
      }

      // 人的会话：先建授权上下文，再按三条规则判。守卫设在 `auth` 与 `authz` 上，
      // 路由自己的认证/授权中间件随后会各自再解析一次，这里不替它们做决定。
      context.set('auth', auth);
      let denial: { reason: string; message: string } | undefined;
      // `authorization.middleware()` 的签名只认自己的环境；这里上下文里同时有 `auth`，
      // 运行期正是它需要的（身份步骤读 `context.get('auth')`）。
      await authorization.middleware()(
        context as unknown as Context<AuthorizationEnv, string>,
        async () => {
          const authz = context.get('authz');
          const granted = await Promise.all(
            AI_GRANTS.map((grant) => authz.can(grant)),
          );
          if (!granted.some(Boolean)) {
            denial = {
              reason: 'AI_ACCESS_REQUIRED',
              message: AI_ACCESS_MESSAGE,
            };
            return;
          }
          if (
            context.req.method === 'POST' &&
            path === REGISTRATION_TOKENS &&
            !(await authz.can(RUNNERS_MANAGE))
          ) {
            denial = {
              reason: 'RUNNER_REGISTRATION_FORBIDDEN',
              message:
                'Issuing a runner registration token needs agents.runners manage permission.',
            };
            return;
          }
          if (
            context.req.method === 'PATCH' &&
            RUNNER.test(path) &&
            (await requestedTrust(context)) === 'team' &&
            !(await authz.can(RUNNERS_MANAGE))
          ) {
            denial = {
              reason: 'RUNNER_TRUST_FORBIDDEN',
              message:
                'Sharing a runner with all users (trust team) needs agents.runners manage permission.',
            };
            return;
          }
          await next();
        },
      );
      if (!denial) return;
      return deny(context, 'session', denial.reason, denial.message);
    });
  },
});
