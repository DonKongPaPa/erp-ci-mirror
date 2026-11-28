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
  type CompositeResourceConditions,
  type AuthorizationDecision,
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
  BomListQuery,
  BomListSchema,
  BomSchema,
  CreateBomBody,
  EffectiveQuery,
  ExplodeQuery,
  ExplodeResultSchema,
  UpdateBomBody,
} from './schemas.js';
import {
  bomExploderToken,
  MAX_DEPTH,
} from '../providers/bom-explode.js';
import {
  bomsMutationsToken,
  bomsReaderToken,
  BomRuleError,
  type BomRuleCode,
} from '../providers/boms.js';

export type BomAction = 'view' | 'explode' | 'create' | 'update' | 'void';
export type BomContext = Context<AuthEnv & AuthorizationEnv>;
export type BomDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<BomRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'invalid-input': { status: 'INVALID_ARGUMENT' },
  'bom-not-found': { status: 'NOT_FOUND' },
  'version-taken': { status: 'ALREADY_EXISTS' },
  'product-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-duplicated': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  cycle: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-effective': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'bom-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'file-not-found': { status: 'NOT_FOUND' },
  'file-unavailable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

const REASON: Readonly<Record<BomRuleCode, string>> = {
  'invalid-input': 'BOM_INVALID_INPUT',
  'bom-not-found': 'BOM_NOT_FOUND',
  'version-taken': 'BOM_VERSION_TAKEN',
  'product-invalid': 'BOM_PRODUCT_INVALID',
  'line-duplicated': 'BOM_LINE_DUPLICATED',
  cycle: 'BOM_CYCLE',
  'not-effective': 'BOM_NOT_EFFECTIVE',
  'bom-inactive': 'BOM_INACTIVE',
  'item-not-found': 'ITEM_NOT_FOUND',
  'file-not-found': 'FILE_NOT_FOUND',
  'file-unavailable': 'FILE_UNAVAILABLE',
};

const camelOf = (code: BomRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

export const objectResponse = (
  schema: Parameters<typeof resolver>[0],
  description: string,
) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

export const unprocessableResponse = objectResponse(
  BomSchema,
  'The request violates a BOM rule (422).',
);

/** 只有 BomRuleError 翻译成稳定规则码；其它异常原样抛出。 */
export function bomApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof BomRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: REASON[error.code],
    domain: 'boms',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`boms.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

export async function authorizeBoms(
  context: BomContext,
  action: BomAction,
): Promise<BomDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'boms' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

/** 价格动作是独立只读动作；conditional（root）不算拒绝。 */
export async function hasItemsPurchasePrice(context: BomContext): Promise<boolean> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'items' },
    action: 'viewPurchasePrice',
  });
  return decision.effect !== 'deny';
}

export const withBomErrors = async <T>(
  context: BomContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw bomApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

export function bomRuleError(
  context: BomContext,
  code: BomRuleCode,
  detail?: string,
): ApiError {
  return bomApiError(
    new BomRuleError(code, detail),
    getRequestTranslator(context),
    getRequestLocale(context) ?? 'zh-CN',
  );
}

/** 1 / 正整数 / all；越界与乱码都是 400 BOM_INVALID_INPUT。 */
function parseLevels(context: BomContext, raw: string | undefined): number {
  if (raw === undefined || raw === 'all') return MAX_DEPTH;
  if (!/^\d+$/u.test(raw)) throw bomRuleError(context, 'invalid-input', 'levels');
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw bomRuleError(context, 'invalid-input', 'levels');
  }
  return Math.min(parsed, MAX_DEPTH);
}

/**
 * R-019 波 2 的七条端点：读给 `boms.view`，展开给 `boms.explode`，
 * 建、改、停用只给 `boms.create` / `update` / `void`。没有删除端点。
 * 每个 handler 第一行先鉴权，之后才碰请求内容。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(bomsReaderToken);
    const mutations = app.container.resolve(bomsMutationsToken);
    const exploder = app.container.resolve(bomExploderToken);

    for (const base of ['/boms', '/boms/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    // 静态段先注册，避免被 /boms/:id 抢先匹配。
    router.get(
      '/boms/effective',
      describeRoute({
        tags: ['BOM'],
        summary: 'Read the BOM version effective on a date',
        operationId: 'effectiveBom',
        responses: {
          '200': objectResponse(BomSchema, 'The effective BOM header'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', EffectiveQuery),
      async (context) => {
        await authorizeBoms(context, 'explode');
        const query = context.req.valid('query');
        const bom = await withBomErrors(context, async () =>
          await exploder.effective(query.productId, query.asOf));
        return context.json({ bom });
      },
    );

    router.get(
      '/boms/explode',
      describeRoute({
        tags: ['BOM'],
        summary: 'Explode a BOM as of a date (single or multi level)',
        description:
          'Requires boms.explode. levels accepts 1, a positive integer or all (max 32). Cost columns appear only when includeCost=1 and the caller holds items.viewPurchasePrice.',
        operationId: 'explodeBom',
        responses: {
          '200': objectResponse(ExplodeResultSchema, 'The exploded tree and totals'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ExplodeQuery),
      async (context) => {
        await authorizeBoms(context, 'explode');
        const query = context.req.valid('query');
        const levels = parseLevels(context, query.levels);
        const includeCost =
          query.includeCost === '1' && await hasItemsPurchasePrice(context);
        const result = await withBomErrors(context, async () =>
          await exploder.explode(query.productId, query.asOf, levels, includeCost));
        return context.json(result);
      },
    );

    router.get(
      '/boms',
      describeRoute({
        tags: ['BOM'],
        summary: 'List BOM headers',
        operationId: 'listBoms',
        responses: {
          '200': objectResponse(BomListSchema, 'One page of BOM headers'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', BomListQuery),
      async (context) => {
        await authorizeBoms(context, 'view');
        const query = context.req.valid('query');
        const result = await withBomErrors(context, async () => await reader.list(query));
        return context.json({
          items: result.items,
          total: result.total,
          page: query.page,
          pageSize: query.pageSize,
        });
      },
    );

    router.get(
      '/boms/:id',
      describeRoute({
        tags: ['BOM'],
        summary: 'Read one BOM with its lines and files',
        operationId: 'readBom',
        responses: {
          '200': objectResponse(BomSchema, 'The BOM'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeBoms(context, 'view');
        const row = await withBomErrors(context, async () =>
          await reader.detail(context.req.param('id')));
        if (row === undefined) throw bomRuleError(context, 'bom-not-found');
        return context.json(row);
      },
    );

    router.post(
      '/boms',
      describeRoute({
        tags: ['BOM'],
        summary: 'Create a BOM version',
        description:
          'Requires boms.create. docNo is issued by the R-016 code service in the same transaction; the whole line set is written atomically. No delete route exists.',
        operationId: 'createBom',
        responses: {
          '201': objectResponse(BomSchema, 'The created BOM'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateBomBody),
      async (context) => {
        await authorizeBoms(context, 'create');
        const session = context.get('auth');
        if (session?.user?.id === undefined || session.user.id === null) {
          throw bomRuleError(context, 'invalid-input', 'auth');
        }
        const row = await withBomErrors(context, async () =>
          await mutations.create(
            context.req.valid('json'), String(session.user.id),
          ));
        return context.json(row, 201);
      },
    );

    router.patch(
      '/boms/:id',
      describeRoute({
        tags: ['BOM'],
        summary: 'Update a BOM version, replacing all lines when provided',
        operationId: 'updateBom',
        responses: {
          '200': objectResponse(BomSchema, 'The updated BOM'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateBomBody),
      async (context) => {
        await authorizeBoms(context, 'update');
        const row = await withBomErrors(context, async () =>
          await mutations.update(context.req.param('id'), context.req.valid('json')));
        return context.json(row);
      },
    );

    router.post(
      '/boms/:id/void',
      describeRoute({
        tags: ['BOM'],
        summary: 'Void a BOM (status inactive; never delete)',
        operationId: 'voidBom',
        responses: {
          '200': objectResponse(BomSchema, 'The voided BOM'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeBoms(context, 'void');
        const row = await withBomErrors(context, async () =>
          await mutations.void(context.req.param('id')));
        return context.json(row);
      },
    );

    return new Hono().route('/', router);
  },
);
