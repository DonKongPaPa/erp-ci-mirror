import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import {
  AuthorizationDeniedError,
  type AuthorizationDecision,
  type CompositeResourceConditions,
} from '@nocobase/authorization/core';
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
import {
  getRequestLocale,
  getRequestTranslator,
  type Translator,
} from '@nocobase/i18n/server';
import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { FileIdsSchema } from './schemas.js';
import { DocFileRuleError } from '../providers/doc-files.js';
import {
  TransferRuleError,
  transferMutationsToken,
  transferReaderToken,
  type TransferRuleCode,
} from '../providers/transfer.js';

/** R-020 波 1：调拨单五个端点。先授权、后取内容；不提供删除。 */
type TransferAction = 'view' | 'create' | 'update' | 'post' | 'void';
type TransferContext = Context<AuthEnv & AuthorizationEnv>;
type TransferDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<TransferRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'transfer-not-found': { status: 'NOT_FOUND' },
  'transfer-not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'transfer-qty-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'transfer-insufficient': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'transfer-same-warehouse': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'warehouse-not-found': { status: 'NOT_FOUND' },
  'warehouse-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-update': { status: 'INVALID_ARGUMENT' },
};

const RULE_REASON: Readonly<Record<TransferRuleCode, string>> = {
  'transfer-not-found': 'TRANSFER_NOT_FOUND',
  'transfer-not-draft': 'TRANSFER_NOT_DRAFT',
  'transfer-qty-invalid': 'TRANSFER_QTY_INVALID',
  'transfer-insufficient': 'TRANSFER_INSUFFICIENT',
  'transfer-same-warehouse': 'TRANSFER_SAME_WAREHOUSE',
  'warehouse-not-found': 'WAREHOUSE_NOT_FOUND',
  'warehouse-inactive': 'WAREHOUSE_INACTIVE',
  'item-not-found': 'ITEM_NOT_FOUND',
  'item-inactive': 'ITEM_INACTIVE',
  'person-invalid': 'STOCK_PERSON_INVALID',
  'line-invalid': 'STOCK_LINE_INVALID',
  'empty-update': 'EMPTY_UPDATE',
};

const camelOf = (code: TransferRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const isoDate = z.string().datetime({ offset: true });
const id = z.string().min(1).max(64);
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const status = z.enum(['draft', 'posted', 'void']);
const lineInput = z.object({
  itemId: id,
  qty: z.number(),
  transferQty: z.number().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const TransferListQuery = z.object({
  transferInWarehouseId: id.optional(),
  transferOutWarehouseId: id.optional(),
  status: status.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const CreateTransferBody = z.object({
  transferInWarehouseId: id,
  transferOutWarehouseId: id.nullable().optional(),
  docDate: day.nullable().optional(),
  handlerUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds: FileIdsSchema,
  lines: z.array(lineInput).default([]),
});
export const UpdateTransferBody = z.object({
  transferInWarehouseId: id.optional(),
  transferOutWarehouseId: id.nullable().optional(),
  docDate: day.nullable().optional(),
  handlerUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds: FileIdsSchema,
  lines: z.array(lineInput).optional(),
});

const person = z.object({ userId: z.string(), name: z.string() });
const ref = z.object({ id: z.string(), name: z.string() });
const item = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  spec: z.string().nullable(), unitCode: z.string(),
});
const line = z.object({
  id: z.string(), itemId: z.string(), qty: z.number(),
  transferQty: z.number().nullable(), note: z.string().nullable(), item,
});
const TransferSchema = z.object({
  id: z.string(), docNo: z.string(), docDate: z.string().nullable(), status,
  warehouseIn: ref, warehouseOut: ref.nullable(), handler: person.nullable(),
  remark: z.string(), createdAt: z.string(), updatedAt: z.string(),
  lines: z.array(line).optional(),
  files: z.array(z.object({
    id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
  })).optional(),
});
const TransferListSchema = z.object({
  items: z.array(TransferSchema.omit({ lines: true, files: true })),
  total: z.number(), page: z.number(), pageSize: z.number(),
});
const PostResultSchema = z.object({
  transfer: TransferSchema,
  outDocId: z.string().nullable(),
  inDocId: z.string(),
});

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});
const unprocessable = objectResponse(TransferSchema, 'The request violates a transfer rule (422).');

function transferApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (error instanceof DocFileRuleError) {
    const status = error.code === 'file-not-found' ? 'NOT_FOUND'
      : error.code === 'file-unavailable' ? 'FAILED_PRECONDITION' : 'INVALID_ARGUMENT';
    throw new ApiError({
      status,
      reason: error.code === 'file-not-found' ? 'FILE_NOT_FOUND'
        : error.code === 'file-unavailable' ? 'FILE_UNAVAILABLE' : 'FILE_TOO_MANY',
      domain: 'docFiles',
      message: error.message,
      ...(status === 'FAILED_PRECONDITION' ? { httpStatus: 422 as const } : {}),
      cause: error,
    });
  }
  if (!(error instanceof TransferRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'transfers',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`transfer.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeTransfer(
  context: TransferContext,
  action: TransferAction,
): Promise<TransferDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'transfers' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

function actorOf(context: TransferContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'transfers', message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const withMappedErrors = async <T>(
  context: TransferContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw transferApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes((app) => {
  const router = new Hono<AuthEnv & AuthorizationEnv>();
  const auth = app.container.resolve(authenticationToken);
  const authz = app.container.resolve(authorizationToken);
  const reader = app.container.resolve(transferReaderToken);
  const mutations = app.container.resolve(transferMutationsToken);

  for (const base of ['/transfers', '/transfers/*']) {
    router.use(base, auth.required(), authz.middleware());
  }

  router.get(
    '/transfers',
    describeRoute({
      tags: ['Transfers'],
      summary: 'List transfers',
      operationId: 'listTransfers',
      responses: {
        '200': objectResponse(TransferListSchema, 'One page of transfers'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', TransferListQuery),
    async (context) => {
      await authorizeTransfer(context, 'view');
      const query = context.req.valid('query');
      const result = await reader.list(query);
      return context.json({ ...result, page: query.page, pageSize: query.pageSize });
    },
  );

  router.get(
    '/transfers/:id',
    describeRoute({
      tags: ['Transfers'],
      summary: 'Read one transfer with its lines',
      operationId: 'readTransfer',
      responses: {
        '200': objectResponse(TransferSchema, 'The transfer with lines'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeTransfer(context, 'view');
      const row = await reader.detail(context.req.param('id'));
      if (row === undefined) {
        throw transferApiError(
          new TransferRuleError('transfer-not-found'),
          getRequestTranslator(context),
          getRequestLocale(context) ?? 'zh-CN',
        );
      }
      return context.json(row);
    },
  );

  router.post(
    '/transfers',
    describeRoute({
      tags: ['Transfers'],
      summary: 'Create a transfer draft',
      operationId: 'createTransfer',
      responses: {
        '201': objectResponse(TransferSchema, 'The created transfer'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', CreateTransferBody),
    async (context) => {
      await authorizeTransfer(context, 'create');
      const row = await withMappedErrors(context, async () =>
        mutations.create(context.req.valid('json'), actorOf(context)),
      );
      return context.json(row, 201);
    },
  );

  router.patch(
    '/transfers/:id',
    describeRoute({
      tags: ['Transfers'],
      summary: 'Update a draft transfer',
      operationId: 'updateTransfer',
      responses: {
        '200': objectResponse(TransferSchema, 'The updated transfer'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '404': apiErrorResponse(404),
        '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', UpdateTransferBody),
    async (context) => {
      await authorizeTransfer(context, 'update');
      const row = await withMappedErrors(context, async () =>
        mutations.update(context.req.param('id'), context.req.valid('json'), actorOf(context)),
      );
      return context.json(row);
    },
  );

  router.post(
    '/transfers/:id/post',
    describeRoute({
      tags: ['Transfers'],
      summary: 'Post a transfer draft',
      description:
        'Requires transfers.post. Generates and posts the outgoing and incoming stock documents in one transaction.',
      operationId: 'postTransfer',
      responses: {
        '200': objectResponse(PostResultSchema, 'The posted transfer and generated document ids'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeTransfer(context, 'post');
      const result = await withMappedErrors(context, async () =>
        mutations.post(context.req.param('id'), actorOf(context)),
      );
      return context.json(result);
    },
  );

  router.post(
    '/transfers/:id/void',
    describeRoute({
      tags: ['Transfers'],
      summary: 'Void a draft transfer',
      operationId: 'voidTransfer',
      responses: {
        '200': objectResponse(TransferSchema, 'The voided transfer'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeTransfer(context, 'void');
      const row = await withMappedErrors(context, async () =>
        mutations.void(context.req.param('id'), actorOf(context)),
      );
      return context.json(row);
    },
  );

  return new Hono().route('/', router);
});
