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
  CreateItemBody,
  ItemListQuery,
  ItemListSchema,
  ItemSchema,
  UpdateItemBody,
} from './schemas.js';
import {
  itemsMutationsToken,
  itemsReaderToken,
  ItemRuleError,
  type ItemRuleCode,
} from '../providers/items.js';

export type ItemsAction = 'view' | 'manage';
export type ItemsContext = Context<AuthEnv & AuthorizationEnv>;
export type ItemsDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 422 不在框架状态表里，用 httpStatus 显式指定（同 shifts.ts）。 */
const RULE_STATUS: Readonly<
  Record<ItemRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'invalid-input': { status: 'INVALID_ARGUMENT' },
  'item-not-found': { status: 'NOT_FOUND' },
  'unit-not-found': { status: 'NOT_FOUND' },
  'category-not-found': { status: 'NOT_FOUND' },
  'code-taken': { status: 'ALREADY_EXISTS' },
  'unit-code-taken': { status: 'ALREADY_EXISTS' },
  'category-code-taken': { status: 'ALREADY_EXISTS' },
  'item-code-immutable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-patch': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'unit-in-use': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'unit-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'category-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'invalid-parent': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

/** 稳定的规则码；前端按 reason 分支，文案在 server/locales。 */
const REASON: Readonly<Record<ItemRuleCode, string>> = {
  'invalid-input': 'ITEM_INVALID_INPUT',
  'item-not-found': 'ITEM_NOT_FOUND',
  'unit-not-found': 'UNIT_NOT_FOUND',
  'category-not-found': 'CATEGORY_NOT_FOUND',
  'code-taken': 'ITEM_CODE_TAKEN',
  'unit-code-taken': 'UNIT_CODE_TAKEN',
  'category-code-taken': 'CATEGORY_CODE_TAKEN',
  'item-code-immutable': 'ITEM_CODE_IMMUTABLE',
  'empty-patch': 'ITEM_EMPTY_PATCH',
  'unit-in-use': 'UNIT_IN_USE',
  'unit-inactive': 'UNIT_INACTIVE',
  'category-inactive': 'CATEGORY_INACTIVE',
  'item-inactive': 'ITEM_INACTIVE',
  'invalid-parent': 'CATEGORY_INVALID_PARENT',
};

const camelOf = (code: ItemRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

export const objectResponse = (
  schema: Parameters<typeof resolver>[0],
  description: string,
) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

export const unprocessableResponse = objectResponse(
  ItemSchema,
  'The request violates an item rule (422).',
);

/** 三片端点共用的错误映射：只有 ItemRuleError 才翻译成稳定的 reason。 */
export function itemApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof ItemRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: REASON[error.code],
    domain: 'items',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`items.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

export async function authorizeItems(
  context: ItemsContext,
  action: ItemsAction,
): Promise<ItemsDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'items' },
    action,
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

export const withItemErrors = async <T>(
  context: ItemsContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw itemApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/** 422 的规则错误（不是抛异常的服务层错误）也走同一份映射。 */
export function itemRuleError(
  context: ItemsContext,
  code: ItemRuleCode,
  detail?: string,
): ApiError {
  return itemApiError(
    new ItemRuleError(code, detail),
    getRequestTranslator(context),
    getRequestLocale(context) ?? 'zh-CN',
  );
}

/** PATCH 里出现这个键就是想改编码；编码是发号器发的，不接受就地改。 */
export const IMMUTABLE_KEYS = ['code'] as const;

export function missingItem(
  context: ItemsContext,
  code: ItemRuleCode,
): ApiError {
  return itemRuleError(context, code);
}

/**
 * R-019 的四个物料端点：读给 `items.view`，写给 `items.manage`，没有删除。
 * 授权在 handler 第一行、进服务之前；非 root 撞码也先得 403。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(itemsReaderToken);
    const mutations = app.container.resolve(itemsMutationsToken);

    for (const base of ['/items', '/items/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/items',
      describeRoute({
        tags: ['Items'],
        summary: 'List materials and products',
        description:
          'Requires items.view. Paginated 20 per page, at most 100; q matches code, name, spec and legacyCode. Filter by status, itemType and categoryCode. Sorted by code ascending.',
        operationId: 'listItems',
        responses: {
          '200': objectResponse(ItemListSchema, 'One page of items'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ItemListQuery),
      async (context) => {
        await authorizeItems(context, 'view');
        const query = context.req.valid('query');
        const result = await reader.list(query);
        return context.json({
          items: result.items,
          total: result.total,
          page: query.page,
          pageSize: query.pageSize,
        });
      },
    );

    router.get(
      '/items/:id',
      describeRoute({
        tags: ['Items'],
        summary: 'Read one item, including inactive ones',
        operationId: 'readItem',
        responses: {
          '200': objectResponse(ItemSchema, 'The item'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeItems(context, 'view');
        const row = await reader.detail(context.req.param('id'));
        if (row === undefined) throw missingItem(context, 'item-not-found');
        return context.json(row);
      },
    );

    router.post(
      '/items',
      describeRoute({
        tags: ['Items'],
        summary: 'Create a material or product',
        description:
          'Requires items.manage. The code is issued by the R-016 code service inside the business transaction (M for material, P for product); a code in the request body is ignored. No delete route exists.',
        operationId: 'createItem',
        responses: {
          '201': objectResponse(ItemSchema, 'The created item'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateItemBody),
      async (context) => {
        await authorizeItems(context, 'manage');
        const session = context.get('auth');
        if (session?.user?.id === undefined || session.user.id === null) {
          throw itemRuleError(context, 'invalid-input', 'auth');
        }
        const row = await withItemErrors(context, async () =>
          mutations.create(context.req.valid('json'), String(session.user.id)),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/items/:id',
      describeRoute({
        tags: ['Items'],
        summary: 'Update an item (never its code)',
        description:
          'Requires items.manage. At least one editable field is required; a `code` key in the body is rejected with 422 ITEM_CODE_IMMUTABLE. An inactive item must be reactivated first.',
        operationId: 'updateItem',
        responses: {
          '200': objectResponse(ItemSchema, 'The updated item'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateItemBody),
      async (context) => {
        await authorizeItems(context, 'manage');
        const body = context.req.valid('json');
        const immutable = IMMUTABLE_KEYS.filter((key) =>
          Object.prototype.hasOwnProperty.call(body, key),
        );
        if (immutable.length > 0) {
          throw itemRuleError(context, 'item-code-immutable', immutable.join(', '));
        }
        if (Object.keys(body).length === 0) {
          throw itemRuleError(context, 'empty-patch');
        }
        const row = await withItemErrors(context, async () =>
          mutations.update(context.req.param('id'), body),
        );
        return context.json(row);
      },
    );

    return new Hono().route('/', router);
  },
);
