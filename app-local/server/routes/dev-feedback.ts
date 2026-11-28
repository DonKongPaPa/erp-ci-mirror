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
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';

import { CreateSchema, Target } from '../dev-tools/feedback-schema.js';
import {
  appendFeedback,
  appendNote,
  buildSnapshot,
  InvalidFeedback,
  markSeen,
  type FeedbackSnapshot,
} from '../dev-tools/feedback.js';
import {
  FeedbackUnavailable,
  InvalidAttachment,
  mutateState,
  readAttachment,
  readFeedbackState,
  readRegistry,
  saveAttachment,
} from '../dev-tools/feedback-files.js';
import { isDevAccountSwitcherEnabled } from '../dev-tools/settings.js';

/**
 * R-087 测试反馈的六个端点。沿用开发工具的开关：关着、或不是开发环境就一条路由都不注册（404）。
 * 开着时先认会话、再判管理员、最后才读文件 —— 403 的响应体里不会有任何反馈文本。
 * 没有修改与删除反馈的端点：答复只能追加，状态由主会话用脚本写。这个模块只由
 * `server/dev-tools/register.ts` 动态引入（R-073）。
 */

const NoteSchema = z.object({ text: z.string().min(1) });
const SeenSchema = z.object({ registryId: z.string().min(1) });

const ItemSchema = z.object({
  id: z.string(),
  at: z.string(),
  route: z.string(),
  target: Target,
  text: z.string(),
  kinds: z.array(z.string()),
  severe: z.boolean(),
  screenshot: z.string().nullable(),
  status: z.string(),
  ref: z.string(),
  note: z.string(),
  notes: z.array(z.object({ text: z.string(), at: z.string() })),
  updatedAt: z.string(),
});
const RegistryRowSchema = z.object({
  id: z.string(),
  module: z.string(),
  page: z.string(),
  feature: z.string(),
  route: z.string().optional(),
  source: z.string(),
  status: z.string(),
  betaAt: z.string(),
});
const SnapshotSchema = z.object({
  generatedAt: z.string(),
  items: z.array(ItemSchema),
  registry: z.array(RegistryRowSchema),
  seen: z.record(z.string(), z.string()),
  counts: z.object({
    new: z.number(),
    accepted: z.number(),
    fixed: z.number(),
    wontfix: z.number(),
    duplicate: z.number(),
  }),
});

function adminOnly(): ApiError {
  return new ApiError({
    status: 'PERMISSION_DENIED',
    reason: 'DEV_TOOLS_ADMIN_ONLY',
    domain: 'devTools',
    message: 'The feedback page is available to administrators only.',
  });
}

function badRequest(reason: string): ApiError {
  return new ApiError({
    status: 'INVALID_ARGUMENT',
    reason,
    domain: 'devTools',
    message: 'The feedback is not valid.',
  });
}

function unavailable(error: unknown): ApiError {
  return new ApiError({
    status: 'UNAVAILABLE',
    reason: 'FEEDBACK_SOURCE_MISSING',
    domain: 'devTools',
    message:
      error instanceof Error ? error.message : '测试反馈的数据源读取失败',
  });
}

/** 「管理员」是不受限权限集的指派人，与需求池看板、待确认事项同一判定。 */
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

export function createFeedbackRoutes(): AppApiRouteContribution<Application> {
  return defineApiRoutes((app) => {
    if (!isDevAccountSwitcherEnabled(app)) return new Hono();
    const router = new Hono<AuthEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);

    // Hono 的 use 只匹配精确路径，子路径要另外挂一层，否则 POST 上没有会话、会被误判为 403。
    router.use('/dev/feedback', auth.optional(), requireSignInSession());
    router.use('/dev/feedback/*', auth.optional(), requireSignInSession());

    router.get(
      '/dev/feedback',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Read the test feedback and the feature registry',
        description:
          'Development builds only, administrators only. Reads the untracked state file and the in-repo registry on every request.',
        operationId: 'getDevFeedback',
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
          const [registry, state] = await Promise.all([
            readRegistry(),
            readFeedbackState(),
          ]);
          const snapshot: FeedbackSnapshot = buildSnapshot(registry, state);
          return context.json({ data: snapshot });
        } catch (error) {
          if (error instanceof FeedbackUnavailable) throw unavailable(error);
          throw error;
        }
      },
    );

    router.post(
      '/dev/feedback',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Append a test feedback item',
        description:
          'Development builds only, administrators only. Appends one item with status new; never edits or removes an existing item.',
        operationId: 'postDevFeedback',
        responses: {
          '201': dataResponse(z.object({ id: z.string() })),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '503': apiErrorResponse(503),
        },
      }),
      apiValidator('json', CreateSchema),
      async (context) => {
        await requireAdmin(context, authz);
        const body = context.req.valid('json');
        const at = new Date().toISOString();
        try {
          const id = await mutateState((current) => {
            const appended = appendFeedback(current, body, at);
            return { state: appended.state, result: appended.id };
          });
          return context.json({ data: { id } }, 201);
        } catch (error) {
          if (error instanceof InvalidFeedback) throw badRequest(error.reason);
          if (error instanceof FeedbackUnavailable) throw unavailable(error);
          throw error;
        }
      },
    );

    router.post(
      '/dev/feedback/:id/notes',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Append a note to a test feedback item',
        description:
          'Development builds only, administrators only. Appends a note without changing the original text or status.',
        operationId: 'postDevFeedbackNote',
        responses: {
          '201': dataResponse(SnapshotSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '503': apiErrorResponse(503),
        },
      }),
      apiValidator('json', NoteSchema),
      async (context) => {
        await requireAdmin(context, authz);
        const id = context.req.param('id');
        const body = context.req.valid('json');
        const at = new Date().toISOString();
        try {
          const state = await mutateState((current) => {
            const next = appendNote(current, id, body.text, at);
            return { state: next, result: next };
          });
          const registry = await readRegistry();
          return context.json({ data: buildSnapshot(registry, state) }, 201);
        } catch (error) {
          if (error instanceof InvalidFeedback) throw badRequest(error.reason);
          if (error instanceof FeedbackUnavailable) throw unavailable(error);
          throw error;
        }
      },
    );

    router.post(
      '/dev/feedback/seen',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Mark a registry row as seen with no feedback needed',
        description:
          'Development builds only, administrators only. Records the latest timestamp in the untracked state file; repeated marks only replace the timestamp, never add a second entry.',
        operationId: 'postDevFeedbackSeen',
        responses: {
          '201': dataResponse(
            z.object({ registryId: z.string(), at: z.string() }),
          ),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '503': apiErrorResponse(503),
        },
      }),
      apiValidator('json', SeenSchema),
      async (context) => {
        await requireAdmin(context, authz);
        const { registryId } = context.req.valid('json');
        const at = new Date().toISOString();
        try {
          const registry = await readRegistry();
          if (!registry.some((row) => row.id === registryId)) {
            throw badRequest('UNKNOWN_REGISTRY_ID');
          }
          const recordedAt = await mutateState((current) => {
            const next = markSeen(current, registryId, at);
            return { state: next, result: next.seen[registryId] ?? at };
          });
          return context.json({ data: { registryId, at: recordedAt } }, 201);
        } catch (error) {
          if (error instanceof InvalidFeedback) throw badRequest(error.reason);
          if (error instanceof FeedbackUnavailable) throw unavailable(error);
          throw error;
        }
      },
    );

    router.post(
      '/dev/feedback/attachments',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Upload a screenshot for a test feedback item',
        description:
          'Development builds only, administrators only. Accepts png, webp or jpeg up to 2 MB as a raw binary body.',
        operationId: 'postDevFeedbackAttachment',
        responses: {
          '201': dataResponse(z.object({ attachmentId: z.string() })),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '415': apiErrorResponse(415),
        },
      }),
      bodyLimit({
        maxSize: 2 * 1024 * 1024 + 4096,
        onError: (context) =>
          context.json(
            {
              error: {
                status: 'INVALID_ARGUMENT',
                code: 413,
                reason: 'ATTACHMENT_TOO_LARGE',
                domain: 'devTools',
                message: 'The screenshot is too large.',
              },
            },
            413,
          ),
      }),
      async (context) => {
        await requireAdmin(context, authz);
        try {
          const bytes = new Uint8Array(await context.req.arrayBuffer());
          const attachmentId = await saveAttachment(
            bytes,
            context.req.header('content-type'),
          );
          return context.json({ data: { attachmentId } }, 201);
        } catch (error) {
          if (error instanceof InvalidAttachment) {
            throw new ApiError({
              status: 'INVALID_ARGUMENT',
              reason:
                error.reason === 'SIZE'
                  ? 'ATTACHMENT_TOO_LARGE'
                  : 'ATTACHMENT_TYPE_INVALID',
              domain: 'devTools',
              message: 'The screenshot is not valid.',
              httpStatus: error.reason === 'SIZE' ? 413 : 415,
            });
          }
          throw error;
        }
      },
    );

    router.get(
      '/dev/feedback/attachments/:id',
      describeRoute({
        tags: ['Dev tools'],
        summary: 'Read a feedback screenshot',
        description:
          'Development builds only, administrators only. Returns the image bytes with a fixed content type.',
        operationId: 'getDevFeedbackAttachment',
        responses: {
          '200': { description: 'The image bytes' },
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
        },
      }),
      async (context) => {
        await requireAdmin(context, authz);
        try {
          const { bytes, contentType } = await readAttachment(
            context.req.param('id'),
          );
          context.header('Cache-Control', 'private, no-store');
          context.header('Content-Type', contentType);
          context.header('Content-Length', String(bytes.byteLength));
          context.header('X-Content-Type-Options', 'nosniff');
          context.header(
            'Content-Security-Policy',
            "sandbox; default-src 'none'",
          );
          return context.body(new Uint8Array(bytes));
        } catch (error) {
          if (error instanceof InvalidAttachment) {
            throw new ApiError({
              status: 'NOT_FOUND',
              reason: 'ATTACHMENT_NOT_FOUND',
              domain: 'devTools',
              message: 'The screenshot does not exist.',
              httpStatus: 404,
            });
          }
          throw error;
        }
      },
    );

    return new Hono().route('/', router);
  });
}

export const apiRoutes = createFeedbackRoutes();

export default apiRoutes;
