import { requireSignInSession } from '@nocobase/app-plugin-api-keys/server';
import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication/server';
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import {
  ApiError,
  apiErrorResponse,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

import { buildRequirementsBoard } from '../dev-tools/requirements-board.js';
import { readRequirementsSources } from '../dev-tools/requirements-board-files.js';
import { isDevAccountSwitcherEnabled } from '../dev-tools/settings.js';

/**
 * R-082 看板的只读端点。沿用开发工具的开关：关着、或不是开发环境就一条路由都不注册（404）。
 * 开着时先认会话、再判管理员、最后才读文件算看板 —— 403 的响应体里不会有任何需求数据。
 * 这个模块只由 `server/dev-tools/register.ts` 动态引入，主组合不引用（R-073）。
 */

const BoardSchema = z.object({
  generatedAt: z.string(),
  totals: z.object({
    pool: z.number(),
    parsed: z.number(),
    skipped: z.number(),
  }),
  requirements: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      category: z.string(),
      status: z.string(),
      weight: z.string(),
      hardDeps: z.array(z.string()),
      softDeps: z.array(z.string()),
      note: z.string(),
      lastEntry: z
        .object({ at: z.string(), text: z.string() })
        .nullable(),
      blocking: z.string(),
      blockingDetail: z.string(),
    }),
  ),
});

function adminOnly(): ApiError {
  return new ApiError({
    status: 'PERMISSION_DENIED',
    reason: 'DEV_TOOLS_ADMIN_ONLY',
    domain: 'devTools',
    message: 'The requirements board is available to administrators only.',
  });
}

/** 「管理员」是不受限权限集的指派人，不认死键名（与导入工具同一判定）。 */
async function requireAdmin(
  context: Context<AuthEnv>,
  authz: AppAuthorization,
): Promise<void> {
  const userId = context.get('auth')?.user?.id;
  if (userId === undefined || userId === null) throw adminOnly();
  const effective = await authz.permissionSets.getEffective({
    principal: { type: 'user', id: String(userId) },
  });
  const admin = effective.some(
    (set) => authz.permissionSets.protection(set.key)?.unrestricted === true,
  );
  if (!admin) throw adminOnly();
}

export function createRequirementsBoardRoutes(): AppApiRouteContribution<Application> {
  return defineApiRoutes((app) => {
    if (!isDevAccountSwitcherEnabled(app)) return new Hono();
    const router = new Hono<AuthEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);

    router.use('/dev/requirements-board', auth.optional(), requireSignInSession());
    router.get(
      '/dev/requirements-board',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Read the requirements board from the requirements pool',
        description:
          'Development builds only, administrators only. Reads the requirements pool and follow-up records on every request; never writes back.',
        operationId: 'getDevRequirementsBoard',
        responses: {
          '200': dataResponse(BoardSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '503': apiErrorResponse(503),
        },
      }),
      async (context) => {
        await requireAdmin(context, authz);
        let board;
        try {
          const sources = await readRequirementsSources();
          board = buildRequirementsBoard(sources.pool, sources.followUps);
        } catch (error) {
          throw new ApiError({
            status: 'UNAVAILABLE',
            reason: 'REQUIREMENTS_SOURCE_MISSING',
            domain: 'devTools',
            message:
              error instanceof Error ? error.message : '需求池数据源读取失败',
          });
        }
        return context.json({ data: board });
      },
    );

    return new Hono().route('/', router);
  });
}

export const apiRoutes = createRequirementsBoardRoutes();

export default apiRoutes;
