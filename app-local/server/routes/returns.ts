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
  CreateReturnBody,
  FinanceOptionListSchema,
  FinanceOptionQuery,
  ReturnListQuery,
  ReturnListSchema,
  ReturnSchema,
  SourceOptionListSchema,
  SourceOptionQuery,
  UpdateReturnBody,
  VoidReturnBody,
  PostResultSchema,
} from './returns-schemas.js';
import { DocFileRuleError } from '../providers/doc-files.js';
import { StockRuleError } from '../providers/inventory.js';
import {
  ReturnRuleError,
  returnsMutationsToken,
  returnsReaderToken,
  type ReturnKind,
  type ReturnRuleCode,
} from '../providers/returns.js';

/**
 * R-020 复刻波 2 加片二：采购退货与销售退货的端点。先授权、后读内容；没有删除路由。
 * 两个资源各自的动作分开授权：发起、改、读、作废给采购 / 销售，过账给仓库，
 * 财务只有销售退货的 finance-options 窄读。
 */
type ReturnAction = 'view' | 'create' | 'update' | 'post' | 'void' | 'financeView' | 'postView';
type ReturnsContext = Context<AuthEnv & AuthorizationEnv>;
type ReturnsDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<ReturnRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'return-not-found': { status: 'NOT_FOUND' },
  'return-not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'qty-exceed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'source-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'partner-mixed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'warehouse-not-found': { status: 'NOT_FOUND' },
  'warehouse-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  insufficient: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-update': { status: 'INVALID_ARGUMENT' },
};

const RULE_REASON: Readonly<Record<ReturnRuleCode, string>> = {
  'return-not-found': 'RETURN_NOT_FOUND',
  'return-not-draft': 'RETURN_NOT_DRAFT',
  'qty-exceed': 'RETURN_QTY_EXCEED',
  'source-invalid': 'RETURN_SOURCE_INVALID',
  'partner-mixed': 'RETURN_PARTNER_MIXED',
  'warehouse-not-found': 'WAREHOUSE_NOT_FOUND',
  'warehouse-inactive': 'WAREHOUSE_INACTIVE',
  'item-not-found': 'ITEM_NOT_FOUND',
  'item-inactive': 'ITEM_INACTIVE',
  'person-invalid': 'STOCK_PERSON_INVALID',
  insufficient: 'STOCK_INSUFFICIENT',
  'empty-update': 'EMPTY_UPDATE',
};

const camelOf = (code: ReturnRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});
const unprocessable = objectResponse(ReturnSchema, 'The request violates a return rule (422).');

function returnsApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (error instanceof DocFileRuleError) {
    const status = error.code === 'file-not-found' ? 'NOT_FOUND'
      : error.code === 'file-unavailable' ? 'FAILED_PRECONDITION' : 'INVALID_ARGUMENT';
    return new ApiError({
      status,
      reason: error.code === 'file-not-found' ? 'FILE_NOT_FOUND'
        : error.code === 'file-unavailable' ? 'FILE_UNAVAILABLE' : 'FILE_TOO_MANY',
      domain: 'docFiles',
      message: error.message,
      ...(status === 'FAILED_PRECONDITION' ? { httpStatus: 422 as const } : {}),
      cause: error,
    });
  }
  if (error instanceof StockRuleError && error.code === 'insufficient') {
    return new ApiError({
      status: 'FAILED_PRECONDITION', reason: 'STOCK_INSUFFICIENT', httpStatus: 422,
      domain: 'returns', message: error.message, cause: error,
    });
  }
  if (!(error instanceof ReturnRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'returns',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`returns.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '', defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeReturns(
  context: ReturnsContext,
  kind: ReturnKind,
  action: ReturnAction,
): Promise<ReturnsDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: kind === 'purchase' ? 'purchaseReturns' : 'salesReturns' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

async function authorizeReturnsRead(
  context: ReturnsContext,
  kind: ReturnKind,
): Promise<void> {
  try {
    await authorizeReturns(context, kind, 'view');
  } catch (error) {
    if (!(error instanceof AuthorizationDeniedError)) throw error;
    // 仓管只有 postView：只读待过账的退货单，写动作仍走各自资源动作。
    try {
      await authorizeReturns(context, kind, 'postView');
    } catch {
      throw error;
    }
  }
}

function actorOf(context: ReturnsContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'returns', message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const withMappedErrors = async <T>(
  context: ReturnsContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw returnsApiError(
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
  const reader = app.container.resolve(returnsReaderToken);
  const mutations = app.container.resolve(returnsMutationsToken);

  for (const base of ['/purchase-returns', '/purchase-returns/*', '/sales-returns', '/sales-returns/*']) {
    router.use(base, auth.required(), authz.middleware());
  }

  for (const kind of ['purchase', 'sales'] as const) {
    const base = kind === 'purchase' ? '/purchase-returns' : '/sales-returns';
    const tag = kind === 'purchase' ? 'PurchaseReturns' : 'SalesReturns';
    const resource = kind === 'purchase' ? 'purchaseReturns' : 'salesReturns';

    router.get(
      `${base}/source-options`,
      describeRoute({
        tags: [tag], summary: `List returnable source documents (${kind})`,
        operationId: `list${tag}SourceOptions`,
        responses: {
          '200': objectResponse(SourceOptionListSchema, 'One page of returnable documents'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', SourceOptionQuery),
      async (context) => {
        await authorizeReturns(context, kind, 'view');
        const query = context.req.valid('query');
        const result = await reader.sourceOptions(kind, query);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    if (kind === 'sales') {
      router.get(
        `${base}/finance-options`,
        describeRoute({
          tags: [tag], summary: 'List posted sales returns for receivables (narrow shape)',
          operationId: 'listSalesReturnsFinanceOptions',
          responses: {
            '200': objectResponse(FinanceOptionListSchema, 'One page of narrow finance rows'),
            '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
          },
        }),
        apiValidator('query', FinanceOptionQuery),
        async (context) => {
          await authorizeReturns(context, kind, 'financeView');
          const query = context.req.valid('query');
          const result = await reader.financeOptions(query);
          return context.json({ ...result, page: query.page, pageSize: query.pageSize });
        },
      );
    }

    router.get(
      base,
      describeRoute({
        tags: [tag], summary: `List ${kind} returns`, operationId: `list${tag}`,
        responses: {
          '200': objectResponse(ReturnListSchema, 'One page of returns'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ReturnListQuery),
      async (context) => {
        await authorizeReturnsRead(context, kind);
        const query = context.req.valid('query');
        const result = await reader.list(kind, query);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      `${base}/:id`,
      describeRoute({
        tags: [tag], summary: `Read one ${kind} return`, operationId: `read${tag}`,
        responses: {
          '200': objectResponse(ReturnSchema, 'The return with lines'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeReturnsRead(context, kind);
        const row = await withMappedErrors(context, async () =>
          await reader.detail(kind, context.req.param('id')));
        if (row === undefined) {
          throw returnsApiError(
            new ReturnRuleError('return-not-found'),
            getRequestTranslator(context), getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      base,
      describeRoute({
        tags: [tag], summary: `Create a ${kind} return draft`, operationId: `create${tag}`,
        responses: {
          '201': objectResponse(ReturnSchema, 'The created return'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401),
          '403': apiErrorResponse(403), '422': unprocessable, '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateReturnBody),
      async (context) => {
        await authorizeReturns(context, kind, 'create');
        const row = await withMappedErrors(context, async () =>
          await mutations.create(kind, context.req.valid('json'), actorOf(context)));
        return context.json(row, 201);
      },
    );

    router.patch(
      `${base}/:id`,
      describeRoute({
        tags: [tag], summary: `Replace the lines of a draft ${kind} return`, operationId: `update${tag}`,
        responses: {
          '200': objectResponse(ReturnSchema, 'The updated return'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401),
          '403': apiErrorResponse(403), '404': apiErrorResponse(404),
          '422': unprocessable, '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateReturnBody),
      async (context) => {
        await authorizeReturns(context, kind, 'update');
        const row = await withMappedErrors(context, async () =>
          await mutations.update(kind, context.req.param('id'), context.req.valid('json'), actorOf(context)));
        return context.json(row);
      },
    );

    router.post(
      `${base}/:id/post`,
      describeRoute({
        tags: [tag], summary: `Post a ${kind} return`, operationId: `post${tag}`,
        description: `Requires ${resource}.post (warehouse). Generates and posts a stock document in the same transaction.`,
        responses: {
          '200': objectResponse(PostResultSchema, 'The posted return and generated stock document'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '422': unprocessable, '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeReturns(context, kind, 'post');
        const result = await withMappedErrors(context, async () =>
          await mutations.post(kind, context.req.param('id'), actorOf(context)));
        return context.json(result);
      },
    );

    router.post(
      `${base}/:id/void`,
      describeRoute({
        tags: [tag], summary: `Void a draft ${kind} return`, operationId: `void${tag}`,
        responses: {
          '200': objectResponse(ReturnSchema, 'The voided return'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '422': unprocessable, '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', VoidReturnBody),
      async (context) => {
        await authorizeReturns(context, kind, 'void');
        const reason = context.req.valid('json').reason;
        const row = await withMappedErrors(context, async () =>
          await mutations.void(kind, context.req.param('id'), actorOf(context), reason));
        return context.json(row);
      },
    );
  }

  return new Hono().route('/', router);
});
