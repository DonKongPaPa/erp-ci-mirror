import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication/server';
import type { Application } from '@nocobase/app-server/application';
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
import { Hono } from 'hono';
import { z } from 'zod';

import { readDemoAccounts } from '../dev-tools/demo-accounts.js';
import { isDevAccountSwitcherEnabled } from '../dev-tools/settings.js';

/**
 * R-037 的两个开发工具接口。
 *
 * 只在「开关打开且是开发环境」时注册任何路由；其余时候这条路由贡献是空的，访问得到 404。
 * 这个条件与 provider 启动时用的是同一个函数（`isDevAccountSwitcherEnabled`），两处不会
 * 给出不同的答案。框架不在启动之后接受新的路由贡献，所以条件放在路由工厂里，而不是在
 * provider 里事后挂载。
 *
 * 两个接口都要求已登录；写操作照例校验来源（`auth.required()` 对带 cookie 的写校验 Origin，
 * 缺了 403）。切换的本质是重新登录成目标账户：先注销当前会话，再用框架的 `signInUser`
 * 给目标账户签发一份新会话，把响应里的 `Set-Cookie` 透传给客户端。
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

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    if (!isDevAccountSwitcherEnabled(app)) {
      // 关着、或环境不是开发：一条路由都不注册，访问得到应用的 404。
      return new Hono();
    }
    const router = new Hono<AuthEnv>();
    const auth = app.container.resolve(authenticationToken);
    const database = app.container.resolve(databaseManagerToken);

    router.use('/dev-tools/accounts', auth.required());
    router.use('/dev-tools/switch-account', auth.required());

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

        // `signInUser` 不会注销当前会话；旧会话不主动结束就会一直挂着直到过期。
        // 与官方演示插件一致，退出是尽力而为，失败也继续签发。
        const signOut = new URL('/api/auth/sign-out', request.url);
        await auth
          .handler(
            new Request(signOut, { method: 'POST', headers }),
            clientAddress === undefined ? {} : { clientAddress },
          )
          .catch(() => undefined);

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
