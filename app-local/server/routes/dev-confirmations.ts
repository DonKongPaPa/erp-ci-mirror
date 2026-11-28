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
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { type Context, Hono } from 'hono';
import { z } from 'zod';

import {
  answerError,
  appendAnswer,
  buildSnapshot,
  InvalidConfirmationAnswer,
  type ConfirmationSnapshot,
} from '../dev-tools/confirmations.js';
import {
  ConfirmationsUnavailable,
  mutateState,
  readConfirmationState,
  readQuestions,
} from '../dev-tools/confirmations-files.js';
import { isDevAccountSwitcherEnabled } from '../dev-tools/settings.js';

/**
 * R-083 待确认事项的端点。沿用开发工具的开关：关着、或不是开发环境就一条路由都不注册（404）。
 * 开着时先认会话、再判管理员、最后才读文件 —— 403 的响应体里不会有任何问题文本。
 * 没有修改与删除端点：答复只能追加。这个模块只由 `server/dev-tools/register.ts` 动态引入（R-073）。
 */

const AnswerSchema = z.object({
  answer: z.string(),
  note: z.string().optional(),
});

const QuestionSchema = z.object({
  id: z.string(),
  topic: z.string(),
  question: z.string(),
  default: z.string(),
  options: z.array(z.string()).optional(),
  source: z.string(),
  closed: z.boolean().optional(),
  latestAnswer: z
    .object({ id: z.string(), answer: z.string(), note: z.string(), at: z.string() })
    .nullable(),
  processed: z
    .object({
      id: z.string(),
      status: z.enum(['landed', 'followup', 'withdrawn']),
      ref: z.string(),
      at: z.string(),
      note: z.string(),
    })
    .nullable(),
  group: z.enum(['pending', 'answered', 'processed']),
});

const SnapshotSchema = z.object({
  generatedAt: z.string(),
  counts: z.object({
    pending: z.number(),
    answered: z.number(),
    processed: z.number(),
  }),
  questions: z.array(QuestionSchema),
});

function adminOnly(): ApiError {
  return new ApiError({
    status: 'PERMISSION_DENIED',
    reason: 'DEV_TOOLS_ADMIN_ONLY',
    domain: 'devTools',
    message: 'The confirmations page is available to administrators only.',
  });
}

function badRequest(reason: string): ApiError {
  return new ApiError({
    status: 'INVALID_ARGUMENT',
    reason,
    domain: 'devTools',
    message: 'The answer is not valid.',
  });
}

function unavailable(error: unknown): ApiError {
  return new ApiError({
    status: 'UNAVAILABLE',
    reason: 'CONFIRMATIONS_SOURCE_MISSING',
    domain: 'devTools',
    message: error instanceof Error ? error.message : '待确认事项的数据源读取失败',
  });
}

/** 「管理员」是不受限权限集的指派人，与需求池看板同一判定。 */
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

export function createConfirmationsRoutes(): AppApiRouteContribution<Application> {
  return defineApiRoutes((app) => {
    if (!isDevAccountSwitcherEnabled(app)) return new Hono();
    const router = new Hono<AuthEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);

    // Hono 的 use 只匹配精确路径，子路径要另外挂一层，否则 POST 上没有会话、会被误判为 403。
    router.use('/dev/confirmations', auth.optional(), requireSignInSession());
    router.use('/dev/confirmations/*', auth.optional(), requireSignInSession());

    router.get(
      '/dev/confirmations',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Read the pending confirmations',
        description:
          'Development builds only, administrators only. Reads the question list and the untracked state file on every request; never writes the question list.',
        operationId: 'getDevConfirmations',
        responses: {
          '200': dataResponse(SnapshotSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '503': apiErrorResponse(503),
        },
      }),
      async (context) => {
        await requireAdmin(context, authz);
        try {
          const [questions, state] = await Promise.all([
            readQuestions(),
            readConfirmationState(),
          ]);
          const snapshot: ConfirmationSnapshot = buildSnapshot(questions, state);
          return context.json({ data: snapshot });
        } catch (error) {
          if (error instanceof ConfirmationsUnavailable) throw unavailable(error);
          throw error;
        }
      },
    );

    router.post(
      '/dev/confirmations/:id/answers',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Append an answer to a pending confirmation',
        description:
          'Development builds only, administrators only. Appends an answer; a single-choice answer must be one of the listed options.',
        operationId: 'postDevConfirmationAnswer',
        responses: {
          '201': dataResponse(SnapshotSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '503': apiErrorResponse(503),
        },
      }),
      apiValidator('json', AnswerSchema),
      async (context) => {
        await requireAdmin(context, authz);
        const id = context.req.param('id');
        const body = context.req.valid('json');
        const note = body.note ?? '';
        try {
          const questions = await readQuestions();
          const question = questions.find((item) => item.id === id);
          if (question === undefined) throw badRequest('UNKNOWN_ID');
          const reason = answerError(question, body.answer);
          if (reason !== null) throw badRequest(reason);
          const at = new Date().toISOString();
          const state = await mutateState((current) => {
            const next = appendAnswer(current, id, body.answer, note, at);
            return { state: next, result: next };
          });
          return context.json({ data: buildSnapshot(questions, state) }, 201);
        } catch (error) {
          if (error instanceof InvalidConfirmationAnswer) {
            throw badRequest(error.reason);
          }
          if (error instanceof ConfirmationsUnavailable) throw unavailable(error);
          throw error;
        }
      },
    );

    return new Hono().route('/', router);
  });
}

export const apiRoutes = createConfirmationsRoutes();

export default apiRoutes;
