import { requireSignInSession } from '@nocobase/app-plugin-api-keys/server';
import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication/server';
import type { Application } from '@nocobase/app-server/application';
import { loggingToken } from '@nocobase/app-server/logging';
import { databaseManagerToken } from '@nocobase/db';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  getClientAddress,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

import {
  type DevAccount,
  readDemoAccounts,
} from '../dev-tools/demo-accounts.js';
import { isDevAccountSwitcherEnabled } from '../dev-tools/settings.js';

/**
 * R-037 的两个开发工具接口。
 *
 * 只在「开关打开且是开发环境」时注册任何路由；其余时候这条路由贡献是空的，访问得到 404。
 * 这个条件与 provider 启动时用的是同一个函数（`isDevAccountSwitcherEnabled`），两处不会
 * 给出不同的答案。框架不在启动之后接受新的路由贡献，所以条件放在路由工厂里，而不是在
 * provider 里事后挂载。
 *
 * 两个接口都要求用户会话（`auth.required()` 之外再挡住个人密钥）；写操作照例校验来源
 * （`auth.required()` 对带 cookie 的写校验 Origin，缺了 403）。切换的本质是重新登录成目标账户：
 * 先注销当前会话，注销失败就在签发之前拒绝（旧会话留着会破坏验收第 5 条，且不能没有痕迹），
 * 成功后才用框架的 `signInUser` 给目标账户签发新会话，把 `Set-Cookie` 透传给客户端。
 */

const DevAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  username: z.string(),
  role: z.string(),
});

const SwitchAccountBody = z.object({ userId: z.string().min(1) });

/** 目标不在演示账户清单里。422 不在框架的标准状态表里，显式给 `httpStatus`。 */
function demoAccountNotFound(): ApiError {
  return new ApiError({
    status: 'FAILED_PRECONDITION',
    reason: 'DEMO_ACCOUNT_NOT_FOUND',
    domain: 'devTools',
    message: 'The target user is not one of the demo accounts.',
    httpStatus: 422,
  });
}

/**
 * 注销旧会话失败：记一条警告就拒绝切换，绝不走到签发那一步。
 *
 * 日志只记谁在切、切到哪个演示账户、注销失败的原因（HTTP 状态或错误类型），不记请求头、
 * cookie 或令牌。响应是一个带 reason 的 503：这是下游认证端点没完成，不是调用方写错了。
 */
function signOutFailed(
  app: Application,
  context: Context<AuthEnv>,
  target: DevAccount,
  detail: string,
): ApiError {
  const caller = context.get('auth');
  app.container
    .resolve(loggingToken)
    .getLogger('app')
    .warn(
      {
        reason: 'DEMO_ACCOUNT_SIGN_OUT_FAILED',
        callerId: caller?.user?.id ?? 'unknown',
        targetUsername: target.username,
        signOutFailure: detail,
      },
      'Switching to a demo account failed because the previous session could not be signed out.',
    );
  return new ApiError({
    status: 'UNAVAILABLE',
    reason: 'DEMO_ACCOUNT_SIGN_OUT_FAILED',
    domain: 'devTools',
    message: `Could not end the current session before switching to demo account "${target.username}".`,
  });
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    if (!isDevAccountSwitcherEnabled(app)) {
      // 关着、或环境不是开发：一条路由都不注册，访问得到应用的 404。
      return new Hono();
    }
    const router = new Hono<AuthEnv>();
    const auth = app.container.resolve(authenticationToken);
    const database = app.container.resolve(databaseManagerToken);

    // 只在这两个开发工具接口上收紧：个人密钥不算「已登录」，别处对密钥的态度不动。
    router.use('/dev-tools/accounts', auth.required(), requireSignInSession());
    router.use(
      '/dev-tools/switch-account',
      auth.required(),
      requireSignInSession(),
    );

    router.get(
      '/dev-tools/accounts',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'List the demo accounts a development build can switch to',
        operationId: 'listDevToolAccounts',
        responses: {
          '200': dataResponse(z.array(DevAccountSchema)),
          '401': apiErrorResponse(401),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const accounts = await readDemoAccounts(database.connection());
        return context.json({ data: accounts });
      },
    );

    router.post(
      '/dev-tools/switch-account',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Switch the browser session to a demo account',
        description:
          'Development builds only. Ends the current session, then signs in as the target demo account.',
        operationId: 'switchDevToolAccount',
        responses: {
          '200': dataResponse(DevAccountSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': {
            description:
              'The target is not one of the demo accounts (`DEMO_ACCOUNT_NOT_FOUND`).',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ApiErrorBody' },
              },
            },
          },
          '500': apiErrorResponse(500),
          '503': apiErrorResponse(503),
        },
      }),
      apiValidator('json', SwitchAccountBody),
      async (context) => {
        const { userId } = context.req.valid('json');
        const accounts = await readDemoAccounts(database.connection());
        const target = accounts.find((account) => account.id === userId);
        if (!target) {
          throw demoAccountNotFound();
        }

        const clientAddress = getClientAddress(context);
        const request = context.req.raw;
        // 转发认证相关的头，但不带原请求的 Content-Length：下面两个请求都没有请求体。
        const headers = new Headers(request.headers);
        headers.delete('content-length');

        // `signInUser` 不会注销当前会话。注销失败就停在这里：继续签发会让旧的管理员
        // 会话一直有效、且没有任何痕迹，验收第 5 条在那条路径上就不成立了。
        const signOut = new URL('/api/auth/sign-out', request.url);
        let signOutResponse: Response;
        try {
          signOutResponse = await auth.handler(
            new Request(signOut, { method: 'POST', headers }),
            clientAddress === undefined ? {} : { clientAddress },
          );
        } catch (error) {
          throw signOutFailed(
            app,
            context,
            target,
            error instanceof Error ? error.name : 'unknown',
          );
        }
        if (!signOutResponse.ok) {
          throw signOutFailed(
            app,
            context,
            target,
            `http-${signOutResponse.status}`,
          );
        }

        const signedIn = await auth.signInUser(
          target.id,
          new Request(request.url, { method: 'POST', headers }),
          clientAddress === undefined ? {} : { clientAddress },
        );
        if (!signedIn.ok) {
          throw new ApiError({
            status: 'INTERNAL',
            reason: 'DEMO_ACCOUNT_SIGN_IN_FAILED',
            domain: 'devTools',
            message: `Signing in as demo account "${target.username}" failed with ${signedIn.status}.`,
          });
        }

        const responseHeaders = new Headers({
          'content-type': 'application/json',
        });
        for (const cookie of signedIn.headers.getSetCookie()) {
          responseHeaders.append('set-cookie', cookie);
        }
        return new Response(JSON.stringify({ data: target }), {
          status: 200,
          headers: responseHeaders,
        });
      },
    );

    return new Hono().route('/', router);
  },
);

export default apiRoutes;
