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

import {
  BalanceListQuery,
  BalanceListSchema,
  CreateStockDocBody,
  CreateWarehouseBody,
  DocListQuery,
  StockDocListSchema,
  StockDocSchemaOut,
  TransactionListQuery,
  TransactionListSchema,
  UpdateStockDocBody,
  UpdateWarehouseBody,
  WarehouseListQuery,
  WarehouseListSchema,
} from './inventory-schemas.js';
import {
  StockRuleError,
  stockMutationsToken,
  stockReaderToken,
  type StockRuleCode,
} from '../providers/inventory.js';

type InventoryAction =
  | 'warehouseView'
  | 'warehouseManage'
  | 'stockView'
  | 'stockWrite'
  | 'stockPost'
  | 'stockVoid';
type InventoryContext = Context<AuthEnv & AuthorizationEnv>;
type InventoryDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 422 不在框架状态表里，同 R-012/R-025 用 httpStatus 显式指定。 */
const RULE_STATUS: Readonly<
  Record<StockRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'warehouse-invalid': { status: 'INVALID_ARGUMENT' },
  'warehouse-code-exists': { status: 'ALREADY_EXISTS' },
  'warehouse-not-found': { status: 'NOT_FOUND' },
  'warehouse-code-immutable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'warehouse-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'doc-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'doc-reason-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'doc-not-found': { status: 'NOT_FOUND' },
  'doc-not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  insufficient: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-update': { status: 'INVALID_ARGUMENT' },
};

/** 规则码逐项写死，不用统一前缀拼：任务书点名的是 WAREHOUSE_INACTIVE 这类名字。 */
const RULE_REASON: Readonly<Record<StockRuleCode, string>> = {
  'warehouse-invalid': 'WAREHOUSE_INVALID',
  'warehouse-code-exists': 'WAREHOUSE_CODE_EXISTS',
  'warehouse-not-found': 'WAREHOUSE_NOT_FOUND',
  'warehouse-code-immutable': 'WAREHOUSE_CODE_IMMUTABLE',
  'warehouse-inactive': 'WAREHOUSE_INACTIVE',
  'item-inactive': 'ITEM_INACTIVE',
  'item-not-found': 'ITEM_NOT_FOUND',
  'line-invalid': 'STOCK_LINE_INVALID',
  'doc-invalid': 'STOCK_DOC_INVALID',
  'doc-reason-invalid': 'STOCK_DOC_REASON_INVALID',
  'doc-not-found': 'STOCK_DOC_NOT_FOUND',
  'doc-not-draft': 'STOCK_DOC_NOT_DRAFT',
  insufficient: 'STOCK_INSUFFICIENT',
  'empty-update': 'EMPTY_UPDATE',
};

const camelOf = (code: StockRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessable = objectResponse(
  StockDocSchemaOut,
  'The request violates an inventory rule (422).',
);

function inventoryApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof StockRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'inventory',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`inventory.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeInventory(
  context: InventoryContext,
  action: InventoryAction,
): Promise<InventoryDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'inventory' },
    action,
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

/** 操作人。`auth.required()` 已经挡过未登录，这里是给类型收窄的兜底。 */
function actorOf(context: InventoryContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'inventory',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const withMappedErrors = async <T>(
  context: InventoryContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw inventoryApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/**
 * R-020 的十一个端点：先授权、再读内容。写在 handler 第一行，进服务之前完成，
 * 所以无授权的人发一个重复编码或空明细的请求得到 403，不是 409/422。
 * 不提供删除：没有 DELETE 路由。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(stockReaderToken);
    const mutations = app.container.resolve(stockMutationsToken);

    for (const base of [
      '/warehouses',
      '/warehouses/*',
      '/stock/balances',
      '/stock/transactions',
      '/stock-docs',
      '/stock-docs/*',
    ]) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/warehouses',
      describeRoute({
        tags: ['Inventory'],
        summary: 'List warehouses',
        operationId: 'listWarehouses',
        responses: {
          '200': objectResponse(WarehouseListSchema, 'One page of warehouses'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', WarehouseListQuery),
      async (context) => {
        await authorizeInventory(context, 'warehouseView');
        const query = context.req.valid('query');
        const result = await reader.listWarehouses({
          ...query,
          status: query.status,
          q: query.q,
        });
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.post(
      '/warehouses',
      describeRoute({
        tags: ['Inventory'],
        summary: 'Create a warehouse',
        description: 'Requires inventory.warehouseManage. The code is hand-written and unique.',
        operationId: 'createWarehouse',
        responses: {
          '201': objectResponse(WarehouseListSchema, 'The created warehouse'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateWarehouseBody),
      async (context) => {
        await authorizeInventory(context, 'warehouseManage');
        const row = await withMappedErrors(context, async () =>
          mutations.createWarehouse(context.req.valid('json')),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/warehouses/:id',
      describeRoute({
        tags: ['Inventory'],
        summary: 'Update a warehouse',
        description: 'Requires inventory.warehouseManage. The code is immutable (422).',
        operationId: 'updateWarehouse',
        responses: {
          '200': objectResponse(WarehouseListSchema, 'The updated warehouse'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateWarehouseBody),
      async (context) => {
        await authorizeInventory(context, 'warehouseManage');
        const body = context.req.valid('json');
        if (Object.prototype.hasOwnProperty.call(body, 'code')) {
          throw inventoryApiError(
            new StockRuleError('warehouse-code-immutable'),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        const row = await withMappedErrors(context, async () =>
          mutations.updateWarehouse(context.req.param('id'), body),
        );
        return context.json(row);
      },
    );

    router.get(
      '/stock/balances',
      describeRoute({
        tags: ['Inventory'],
        summary: 'List stock balances',
        operationId: 'listStockBalances',
        responses: {
          '200': objectResponse(BalanceListSchema, 'One page of balances'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', BalanceListQuery),
      async (context) => {
        await authorizeInventory(context, 'stockView');
        const query = context.req.valid('query');
        const result = await reader.listBalances(query);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      '/stock/transactions',
      describeRoute({
        tags: ['Inventory'],
        summary: 'List stock transactions',
        operationId: 'listStockTransactions',
        responses: {
          '200': objectResponse(TransactionListSchema, 'One page of transactions'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', TransactionListQuery),
      async (context) => {
        await authorizeInventory(context, 'stockView');
        const query = context.req.valid('query');
        const result = await reader.listTransactions(query);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      '/stock-docs',
      describeRoute({
        tags: ['Inventory'],
        summary: 'List stock documents',
        operationId: 'listStockDocs',
        responses: {
          '200': objectResponse(StockDocListSchema, 'One page of documents without lines'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', DocListQuery),
      async (context) => {
        await authorizeInventory(context, 'stockView');
        const query = context.req.valid('query');
        const result = await reader.listDocs({
          docType: query.docType,
          status: query.status,
          q: query.q,
          from: query.from,
          to: query.to,
          page: query.page,
          pageSize: query.pageSize,
        });
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      '/stock-docs/:id',
      describeRoute({
        tags: ['Inventory'],
        summary: 'Read one stock document with its lines',
        operationId: 'readStockDoc',
        responses: {
          '200': objectResponse(StockDocSchemaOut, 'The document with lines'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeInventory(context, 'stockView');
        const row = await reader.detailDoc(context.req.param('id'));
        if (row === undefined) {
          throw inventoryApiError(
            new StockRuleError('doc-not-found'),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      '/stock-docs',
      describeRoute({
        tags: ['Inventory'],
        summary: 'Create a stock document with lines',
        description:
          'Requires inventory.stockWrite. The document number is taken from the code generator in the same transaction; the document starts as draft.',
        operationId: 'createStockDoc',
        responses: {
          '201': objectResponse(StockDocSchemaOut, 'The created document with lines'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateStockDocBody),
      async (context) => {
        await authorizeInventory(context, 'stockWrite');
        const row = await withMappedErrors(context, async () =>
          mutations.createDoc(context.req.valid('json'), actorOf(context)),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/stock-docs/:id',
      describeRoute({
        tags: ['Inventory'],
        summary: 'Replace the lines of a draft stock document',
        description:
          'Requires inventory.stockWrite. Drafts only; lines are replaced as a whole. A posted or void document is 422.',
        operationId: 'updateStockDoc',
        responses: {
          '200': objectResponse(StockDocSchemaOut, 'The updated document with lines'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateStockDocBody),
      async (context) => {
        await authorizeInventory(context, 'stockWrite');
        const row = await withMappedErrors(context, async () =>
          mutations.updateDoc(context.req.param('id'), context.req.valid('json')),
        );
        return context.json(row);
      },
    );

    router.post(
      '/stock-docs/:id/post',
      describeRoute({
        tags: ['Inventory'],
        summary: 'Post a draft stock document',
        description:
          'Requires inventory.stockPost. Changes balances and writes transactions in one transaction; insufficient stock returns 422 STOCK_INSUFFICIENT and rolls the whole document back.',
        operationId: 'postStockDoc',
        responses: {
          '200': objectResponse(StockDocSchemaOut, 'The posted document'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeInventory(context, 'stockPost');
        const row = await withMappedErrors(context, async () =>
          mutations.post(context.req.param('id'), actorOf(context)),
        );
        return context.json(row);
      },
    );

    router.post(
      '/stock-docs/:id/void',
      describeRoute({
        tags: ['Inventory'],
        summary: 'Void a draft stock document',
        description:
          'Requires inventory.stockVoid. Drafts only; a posted document cannot be voided (no red reversal in this MVP).',
        operationId: 'voidStockDoc',
        responses: {
          '200': objectResponse(StockDocSchemaOut, 'The voided document'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeInventory(context, 'stockVoid');
        const row = await withMappedErrors(context, async () =>
          mutations.void(context.req.param('id'), actorOf(context)),
        );
        return context.json(row);
      },
    );

    return new Hono().route('/', router);
  },
);
