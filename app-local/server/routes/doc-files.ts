import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import { AuthorizationDeniedError } from '@nocobase/authorization/core';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  defineApiRoutes,
  describeRoute,
  resolver,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { databaseManagerToken } from '@nocobase/db';
import { z } from 'zod';
import type { Knex } from 'knex';
import { Readable } from 'node:stream';

import {
  DOC_FILE_BODY_SLACK,
  DOC_FILE_MAX_BYTES,
  DocFileRuleError,
  docFilesToken,
  type DocFileRecord,
} from '../providers/doc-files.js';
import { DocFileIdParam } from './schemas.js';

type DocContext = Context<AuthEnv & AuthorizationEnv>;
type Check = { readonly resource: string; readonly actions: readonly string[] };

/** 上传：持有任意一种带附件单据的写动作即可；这是跨资源的「至少一种」判断。 */
const WRITE_CHECKS: readonly Check[] = [
  { resource: 'purchaseOrders', actions: ['create', 'update', 'receive'] },
  // R-021 波 1 加片：请购单上传先过建/改动作。
  { resource: 'purchaseRequests', actions: ['create', 'update'] },
  { resource: 'salesOrders', actions: ['create', 'update', 'ship'] },
  { resource: 'inventory', actions: ['stockWrite'] },
  { resource: 'customers', actions: ['create', 'update'] },
  { resource: 'suppliers', actions: ['create', 'update'] },
  { resource: 'expenses', actions: ['create', 'update', 'confirm', 'void'] },
  { resource: 'invoiceReceipts', actions: ['create', 'update', 'confirm', 'void'] },
  // R-066：请款单上传先过建/改动作。
  { resource: 'financeRequests', actions: ['create', 'update'] },
];
// 往来单位附件随它自己的片来做，读取要按侧裁（客户/供应商不能互相放行）。
const READ_CHECKS: Readonly<Record<string, readonly Check[]>> = {
  purchase_order: [{ resource: 'purchaseOrders', actions: ['view', 'receive', 'financeView'] }],
  purchase_request: [{ resource: 'purchaseRequests', actions: ['view', 'convert'] }],
  sales_order: [{ resource: 'salesOrders', actions: ['view', 'ship'] }],
  stock_doc: [{ resource: 'inventory', actions: ['stockView'] }],
  expense: [{ resource: 'expenses', actions: ['view'] }],
  invoice_receipt: [{ resource: 'invoiceReceipts', actions: ['view'] }],
  // R-066：按 docType 分型取附件内容，先过 view 或 convert。
  payment_request: [{ resource: 'financeRequests', actions: ['view', 'convert'] }],
  expense_claim: [{ resource: 'financeRequests', actions: ['view', 'convert'] }],
};

async function may(context: DocContext, checks: readonly Check[]): Promise<boolean> {
  for (const check of checks) {
    for (const action of check.actions) {
      try {
        const decision = await context.get('authz').authorize({
          resource: { type: 'composite', id: check.resource },
          action,
        });
        if (decision.effect !== 'deny') return true;
      } catch {
        // 还没登记的资源（例如财务那一片未并入）等于没有授权。
      }
    }
  }
  return false;
}

function actorOf(context: DocContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'docFiles',
      message: 'An authenticated user is required.',
    });
  }
  return String(session.user.id);
}

function fileError(error: unknown): never {
  if (!(error instanceof DocFileRuleError)) throw error;
  const status = error.code === 'file-not-found'
    ? 'NOT_FOUND'
    : error.code === 'file-unavailable'
      ? 'FAILED_PRECONDITION'
      : 'INVALID_ARGUMENT';
  throw new ApiError({
    status,
    reason: error.code === 'file-not-found'
      ? 'FILE_NOT_FOUND'
      : error.code === 'file-unavailable'
        ? 'FILE_UNAVAILABLE'
        : 'FILE_TOO_MANY',
    domain: 'docFiles',
    message: error.message,
    ...(status === 'FAILED_PRECONDITION' ? { httpStatus: 422 as const } : {}),
    cause: error,
  });
}

const fileSchema = z.object({
  id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
});

/** 取内容时照插件那套响应头：不嗅探、不缓存、只作附件下载。 */
async function sendFile(
  context: DocContext,
  row: DocFileRecord,
  stream: Readable,
): Promise<Response> {
  const filename = Buffer.from(row.name).toString('utf8');
  const encoded = encodeURIComponent(filename).replace(/['()*]/gu, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  context.header('Cache-Control', 'private, no-store');
  context.header('Content-Type', row.contentType);
  context.header('Content-Length', String(row.size));
  context.header('X-Content-Type-Options', 'nosniff');
  context.header('Content-Security-Policy', "sandbox; default-src 'none'");
  context.header('Content-Disposition', `attachment; filename*=UTF-8''${encoded}`);
  return context.body(Readable.toWeb(stream));
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes((app) => {
  const router = new Hono<AuthEnv & AuthorizationEnv>();
  const auth = app.container.resolve(authenticationToken);
  const authz = app.container.resolve(authorizationToken);
  const docFiles = app.container.resolve(docFilesToken);

  router.use('/doc-files', auth.required(), authz.middleware());
  router.use('/doc-files/*', auth.required(), authz.middleware());

  router.post(
    '/doc-files',
    describeRoute({
      tags: ['Documents'],
      summary: 'Upload one document attachment',
      operationId: 'uploadDocFile',
      requestBody: {
        required: true,
        content: {
          'multipart/form-data': {
            schema: {
              type: 'object',
              required: ['file'],
              properties: { file: { type: 'string', format: 'binary' } },
            },
          },
        },
      },
      responses: {
        '201': {
          description: 'The uploaded attachment (no storage key or uploader).',
          content: { 'application/json': { schema: resolver(fileSchema) } },
        },
        '401': apiErrorResponse(401),
        '403': apiErrorResponse(403),
        '413': apiErrorResponse(413),
        '415': apiErrorResponse(415),
        '500': apiErrorResponse(500),
      },
    }),
    // 先授权再读请求体：一种写动作都没有的人一律 403，坏请求体也不会先得到 400。
    async (context, next) => {
      if (!(await may(context, WRITE_CHECKS))) {
        const decision = await context.get('authz').authorize({
          resource: { type: 'composite', id: 'purchaseOrders' },
          action: 'create',
        });
        throw new AuthorizationDeniedError(decision);
      }
      const length = context.req.header('content-length');
      if (length !== undefined && Number(length) > DOC_FILE_MAX_BYTES + DOC_FILE_BODY_SLACK) {
        throw new ApiError({
          status: 'OUT_OF_RANGE', reason: 'FILE_TOO_MANY', domain: 'docFiles',
          message: 'The attachment is too large.', httpStatus: 413,
        });
      }
      context.req.raw.headers.delete('content-length');
      await next();
    },
    bodyLimit({
      maxSize: DOC_FILE_MAX_BYTES + DOC_FILE_BODY_SLACK,
      onError: (c: Context) =>
        c.json(
          {
            error: {
              status: 413, code: 413, reason: 'FILE_TOO_MANY', domain: 'docFiles',
              message: 'The attachment request body is too large.',
            },
          },
          413,
        ),
    }),
    async (context) => {
      const actorId = actorOf(context);
      if (!context.req.header('content-type')?.toLowerCase().startsWith('multipart/form-data;')) {
        throw new ApiError({
          status: 'INVALID_ARGUMENT', reason: 'FILE_UNAVAILABLE', domain: 'docFiles',
          message: 'Expected multipart/form-data.', httpStatus: 422,
        });
      }
      let body: Record<string, unknown>;
      try {
        body = await context.req.parseBody({ all: true });
      } catch {
        throw new ApiError({
          status: 'INVALID_ARGUMENT', reason: 'FILE_UNAVAILABLE', domain: 'docFiles',
          message: 'Invalid multipart body.', httpStatus: 422,
        });
      }
      const file = body.file;
      if (!(file instanceof File) || Array.isArray(file)) {
        throw new ApiError({
          status: 'INVALID_ARGUMENT', reason: 'FILE_UNAVAILABLE', domain: 'docFiles',
          message: 'Exactly one `file` is required.', httpStatus: 422,
        });
      }
      try {
        const view = await docFiles.upload(file, actorId);
        return context.json(view, 201);
      } catch (error) {
        return fileError(error);
      }
    },
  );

  router.get(
    '/doc-files/:id/content',
    describeRoute({
      tags: ['Documents'],
      summary: 'Read the bytes of one attachment',
      operationId: 'getDocFileContent',
      responses: {
        '200': { description: 'The attachment bytes.' },
        '401': apiErrorResponse(401),
        '403': apiErrorResponse(403),
        '404': apiErrorResponse(404),
        '500': apiErrorResponse(500),
      },
    }),
    apiValidator('param', DocFileIdParam),
    async (context) => {
      const database = app.container.resolve(databaseManagerToken);
      const knex = await database.connection().client<Knex>();
      const row = await docFiles.find(knex, context.req.param('id'));
      if (row === undefined) {
        return fileError(new DocFileRuleError('file-not-found'));
      }
      if (row.ownerId === null) {
        if (row.createdById !== actorOf(context)) {
          const decision = await context.get('authz').authorize({
            resource: { type: 'composite', id: 'purchaseOrders' },
            action: 'create',
          });
          throw new AuthorizationDeniedError(decision);
        }
      } else if (!(await may(context, READ_CHECKS[row.ownerType] ?? []))) {
        const decision = await context.get('authz').authorize({
          resource: { type: 'composite', id: 'purchaseOrders' },
          action: 'view',
        });
        throw new AuthorizationDeniedError(decision);
      }
      try {
        return await sendFile(context, row, await docFiles.content(row));
      } catch (error) {
        return fileError(error);
      }
    },
  );

  return new Hono().route('/', router);
});
