import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  defineApiRoutes,
  describeRoute,
  resolver,
  type ApiErrorStatus,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';

import {
  ImportCommitBody,
  ImportDryRunBody,
  ImportKindRawParam,
  ImportParseResponseSchema,
  ImportReportSchema,
} from './schemas.js';
import {
  importToolToken,
  ImportRuleError,
  isImportKind,
  type ImportRuleCode,
  type ImportToolService,
} from '../providers/import-tool.js';

/**
 * R-068 工具加片的三步端点。只有 root 能调：鉴权在 handler 第一行、读文件之前完成，
 * 不注册业务资源与动作、不写种子。用 `auth.optional()` 是为了让匿名也拿到 403
 * （`auth.required()` 会先回 401），同时保留它对带 cookie 写请求的 Origin 校验。
 */
const STATUS: Readonly<
  Record<ImportRuleCode, { status: ApiErrorStatus; httpStatus?: 422 }>
> = {
  IMPORT_KIND_INVALID: { status: 'NOT_FOUND' },
  IMPORT_ENCODING_INVALID: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  IMPORT_HEADER_INVALID: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  IMPORT_DUPLICATE_KEY: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  IMPORT_TOKEN_INVALID: { status: 'NOT_FOUND' },
  IMPORT_NOT_DRY_RUN: { status: 'ABORTED' },
  IMPORT_VALIDATION_FAILED: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  IMPORT_COMMIT_FAILED: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  OPENING_ALREADY_IMPORTED: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  NO_PERMISSION: { status: 'PERMISSION_DENIED' },
};

const importError = (error: unknown): never => {
  if (!(error instanceof ImportRuleError)) throw error;
  const rule = STATUS[error.code as ImportRuleCode];
  throw new ApiError({
    status: rule.status,
    reason: error.code,
    domain: 'imports',
    message: error.message,
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    ...(error.issues.length > 0 ? { metadata: { issues: error.issues } } : {}),
    cause: error,
  });
};

const withImportErrors = async <T>(work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    return importError(error);
  }
};

type ImportContext = Context<AuthEnv>;

/** 「是 root」不认死键名：授权插件把 root 集声明为 unrestricted，按用户主体取有效权限集。 */
async function requireRoot(
  context: ImportContext,
  authz: AppAuthorization,
): Promise<void> {
  const session = context.get('auth');
  const userId = session?.user?.id;
  if (userId === undefined || userId === null) {
    throw new ImportRuleError('NO_PERMISSION');
  }
  const effective = await authz.permissionSets.getEffective({
    principal: { type: 'user', id: String(userId) },
  });
  const root = effective.some(
    (set) => authz.permissionSets.protection(set.key)?.unrestricted === true,
  );
  if (!root) throw new ImportRuleError('NO_PERMISSION');
}

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});
const reportResponse = objectResponse(ImportReportSchema, 'Row counts and row-numbered issues only.');

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const service: ImportToolService = app.container.resolve(importToolToken);

    router.use('/imports/*', auth.optional());

    router.post(
      '/imports/:kind/parse',
      describeRoute({
        tags: ['Imports'],
        summary: 'Parse one UTF-8 CSV (root only)',
        description:
          'Root only. Reads a UTF-8 CSV from multipart/form-data and returns a process-local token valid for 30 minutes. The file is never written to disk. Extra columns are ignored and reported by row number only.',
        operationId: 'parseImport',
        responses: {
          '201': objectResponse(ImportParseResponseSchema, 'Token, row count, headers and warnings'),
          '400': apiErrorResponse(400),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(ImportReportSchema, 'Import rule violated (422).'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('param', ImportKindRawParam),
      async (context) => {
        return await withImportErrors(async () => {
          await requireRoot(context, authz);
          const kind = context.req.param('kind');
          if (!isImportKind(kind)) throw new ImportRuleError('IMPORT_KIND_INVALID');
          const form = await context.req.formData().catch(() => {
            throw new ImportRuleError('IMPORT_HEADER_INVALID');
          });
          const file = form.get('file');
          if (!(file instanceof File)) throw new ImportRuleError('IMPORT_HEADER_INVALID');
          const bytes = new Uint8Array(await file.arrayBuffer());
          const result = await service.parse(kind, bytes, file.type || context.req.header('content-type'));
          return context.json(result, 201);
        });
      },
    );

    router.post(
      '/imports/:kind/dry-run',
      describeRoute({
        tags: ['Imports'],
        summary: 'Dry-run one parsed file without writing (root only)',
        description:
          'Root only. Returns row counts and row-numbered error codes without writing anything. May be repeated.',
        operationId: 'dryRunImport',
        responses: {
          '200': reportResponse,
          '400': apiErrorResponse(400),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(ImportReportSchema, 'Import rule violated (422).'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('param', ImportKindRawParam),
      apiValidator('json', ImportDryRunBody),
      async (context) => {
        return await withImportErrors(async () => {
          await requireRoot(context, authz);
          const kind = context.req.param('kind');
          if (!isImportKind(kind)) throw new ImportRuleError('IMPORT_KIND_INVALID');
          const report = await service.dryRun(kind, context.req.valid('json').token);
          return context.json(report);
        });
      },
    );

    router.post(
      '/imports/:kind/commit',
      describeRoute({
        tags: ['Imports'],
        summary: 'Commit one parsed file as a single transaction (root only)',
        description:
          'Root only. Requires a prior dry-run. Writes every row in one transaction; any error rolls the whole batch back. The token can be used once and is cleared afterwards.',
        operationId: 'commitImport',
        responses: {
          '201': reportResponse,
          '400': apiErrorResponse(400),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': objectResponse(ImportReportSchema, 'Import rule violated (422).'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('param', ImportKindRawParam),
      apiValidator('json', ImportCommitBody),
      async (context) => {
        return await withImportErrors(async () => {
          await requireRoot(context, authz);
          const kind = context.req.param('kind');
          if (!isImportKind(kind)) throw new ImportRuleError('IMPORT_KIND_INVALID');
          const session = context.get('auth');
          const userId = String(session?.user?.id ?? '');
          const body = context.req.valid('json');
          const report = await service.commit(kind, body.token, body.mode, userId);
          return context.json(report, 201);
        });
      },
    );

    return new Hono().route('/', router);
  },
);
