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
  StocktakingRuleError,
  stocktakingMutationsToken,
  stocktakingReaderToken,
  type StocktakingRuleCode,
} from '../providers/stocktaking.js';

/**
 * R-020 波 1：盘点单十二个端点中的五个。先授权、后取内容：无授权的发非法业务值
 * 也是 403，不会先回 422/404。没有删除路由。
 */
type StocktakingAction = 'view' | 'create' | 'update' | 'finish' | 'void';
type StocktakingContext = Context<AuthEnv & AuthorizationEnv>;
type StocktakingDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<StocktakingRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'stocktaking-not-found': { status: 'NOT_FOUND' },
  'stocktaking-not-staging': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'actual-required': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'supervisor-required': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'duplicate-item': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'warehouse-not-found': { status: 'NOT_FOUND' },
  'warehouse-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-update': { status: 'INVALID_ARGUMENT' },
  insufficient: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

const RULE_REASON: Readonly<Record<StocktakingRuleCode, string>> = {
  'stocktaking-not-found': 'STOCKTAKE_NOT_FOUND',
  'stocktaking-not-staging': 'STOCKTAKE_NOT_STAGING',
  'actual-required': 'STOCKTAKE_ACTUAL_REQUIRED',
  'supervisor-required': 'STOCKTAKE_SUPERVISOR_REQUIRED',
  'duplicate-item': 'STOCKTAKE_DUPLICATE_ITEM',
  'warehouse-not-found': 'WAREHOUSE_NOT_FOUND',
  'warehouse-inactive': 'WAREHOUSE_INACTIVE',
  'item-not-found': 'ITEM_NOT_FOUND',
  'item-inactive': 'ITEM_INACTIVE',
  'person-invalid': 'STOCK_PERSON_INVALID',
  'line-invalid': 'STOCK_LINE_INVALID',
  'empty-update': 'EMPTY_UPDATE',
  insufficient: 'STOCK_INSUFFICIENT',
};

const camelOf = (code: StocktakingRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const isoDate = z.string().datetime({ offset: true });
const id = z.string().min(1).max(64);
const status = z.enum(['staging', 'finished', 'void']);
const lineInput = z.object({
  itemId: id,
  actualQty: z.number().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

export const StocktakingListQuery = z.object({
  warehouseId: id.optional(),
  status: status.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});
export const CreateStocktakingBody = z.object({
  warehouseId: id,
  handlerUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds: FileIdsSchema,
  lines: z.array(lineInput).default([]),
});
export const UpdateStocktakingBody = z.object({
  handlerUserId: id.nullable().optional(),
  remark: z.string().max(1000).optional(),
  fileIds: FileIdsSchema,
  lines: z.array(lineInput).optional(),
});
export const FinishStocktakingBody = z.object({ supervisorUserId: z.string().max(64) });

const person = z.object({ userId: z.string(), name: z.string() });
const ref = z.object({ id: z.string(), name: z.string() });
const item = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  spec: z.string().nullable(), unitCode: z.string(), barcode: z.string().nullable(),
});
const line = z.object({
  id: z.string(), itemId: z.string(), systemQty: z.number(),
  actualQty: z.number().nullable(), deltaQty: z.number().nullable(),
  result: z.enum(['balanced', 'profit', 'loss']).nullable(),
  note: z.string().nullable(), item,
});
const StocktakingSchema = z.object({
  id: z.string(), docNo: z.string(), docDate: z.string(), status,
  warehouse: ref, handler: person.nullable(), supervisor: person.nullable(),
  remark: z.string(), createdAt: z.string(), updatedAt: z.string(),
  lines: z.array(line).optional(),
  files: z.array(z.object({
    id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
  })).optional(),
});
const StocktakingListSchema = z.object({
  items: z.array(StocktakingSchema.omit({ lines: true, files: true })),
  total: z.number(), page: z.number(), pageSize: z.number(),
});
const FinishResultSchema = z.object({
  stocktaking: StocktakingSchema,
  profitDocId: z.string().nullable(),
  lossDocId: z.string().nullable(),
});

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});
const unprocessable = objectResponse(StocktakingSchema, 'The request violates a stocktaking rule (422).');

function stocktakingApiError(
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
  if (!(error instanceof StocktakingRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'stocktakings',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`stocktaking.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeStocktaking(
  context: StocktakingContext,
  action: StocktakingAction,
): Promise<StocktakingDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'stocktakings' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

function actorOf(context: StocktakingContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'stocktakings', message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const withMappedErrors = async <T>(
  context: StocktakingContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw stocktakingApiError(
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
  const reader = app.container.resolve(stocktakingReaderToken);
  const mutations = app.container.resolve(stocktakingMutationsToken);

  for (const base of ['/stocktakings', '/stocktakings/*']) {
    router.use(base, auth.required(), authz.middleware());
  }

  router.get(
    '/stocktakings',
    describeRoute({
      tags: ['Stocktakings'],
      summary: 'List stocktakings',
      operationId: 'listStocktakings',
      responses: {
        '200': objectResponse(StocktakingListSchema, 'One page of stocktakings'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', StocktakingListQuery),
    async (context) => {
      await authorizeStocktaking(context, 'view');
      const query = context.req.valid('query');
      const result = await reader.list(query);
      return context.json({ ...result, page: query.page, pageSize: query.pageSize });
    },
  );

  router.get(
    '/stocktakings/:id',
    describeRoute({
      tags: ['Stocktakings'],
      summary: 'Read one stocktaking with its lines',
      operationId: 'readStocktaking',
      responses: {
        '200': objectResponse(StocktakingSchema, 'The stocktaking with lines'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeStocktaking(context, 'view');
      const row = await reader.detail(context.req.param('id'));
      if (row === undefined) {
        throw stocktakingApiError(
          new StocktakingRuleError('stocktaking-not-found'),
          getRequestTranslator(context),
          getRequestLocale(context) ?? 'zh-CN',
        );
      }
      return context.json(row);
    },
  );

  router.post(
    '/stocktakings',
    describeRoute({
      tags: ['Stocktakings'],
      summary: 'Create a stocktaking draft',
      description: 'Requires stocktakings.create. systemQty is snapshotted from current balances.',
      operationId: 'createStocktaking',
      responses: {
        '201': objectResponse(StocktakingSchema, 'The created stocktaking'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', CreateStocktakingBody),
    async (context) => {
      await authorizeStocktaking(context, 'create');
      const row = await withMappedErrors(context, async () =>
        mutations.create(context.req.valid('json'), actorOf(context)),
      );
      return context.json(row, 201);
    },
  );

  router.patch(
    '/stocktakings/:id',
    describeRoute({
      tags: ['Stocktakings'],
      summary: 'Replace the lines of a staging stocktaking',
      operationId: 'updateStocktaking',
      responses: {
        '200': objectResponse(StocktakingSchema, 'The updated stocktaking'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '404': apiErrorResponse(404),
        '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', UpdateStocktakingBody),
    async (context) => {
      await authorizeStocktaking(context, 'update');
      const row = await withMappedErrors(context, async () =>
        mutations.update(context.req.param('id'), context.req.valid('json'), actorOf(context)),
      );
      return context.json(row);
    },
  );

  router.post(
    '/stocktakings/:id/finish',
    describeRoute({
      tags: ['Stocktakings'],
      summary: 'Finish a stocktaking with a supervisor',
      description:
        'Requires stocktakings.finish (finance). Generates and posts the profit and loss stock documents in the same transaction.',
      operationId: 'finishStocktaking',
      responses: {
        '200': objectResponse(FinishResultSchema, 'The finished stocktaking and generated document ids'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '404': apiErrorResponse(404),
        '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', FinishStocktakingBody),
    async (context) => {
      await authorizeStocktaking(context, 'finish');
      const result = await withMappedErrors(context, async () =>
        mutations.finish(context.req.param('id'), context.req.valid('json').supervisorUserId, actorOf(context)),
      );
      return context.json(result);
    },
  );

  router.post(
    '/stocktakings/:id/void',
    describeRoute({
      tags: ['Stocktakings'],
      summary: 'Void a staging stocktaking',
      operationId: 'voidStocktaking',
      responses: {
        '200': objectResponse(StocktakingSchema, 'The voided stocktaking'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeStocktaking(context, 'void');
      const row = await withMappedErrors(context, async () =>
        mutations.void(context.req.param('id'), actorOf(context)),
      );
      return context.json(row);
    },
  );

  return new Hono().route('/', router);
});
