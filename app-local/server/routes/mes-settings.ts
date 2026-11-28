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

import {
  MesRuleError,
  mesSettingsToken,
  type MesListQuery as MesListQueryType,
  type MesPriceInput,
  type MesRow,
  type MesRuleCode,
  type MesSettingKind,
} from '../providers/mes-settings.js';

type MesAction = 'view' | 'maintain' | 'priceView';
type MesContext = Context<AuthEnv & AuthorizationEnv>;
type MesDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 422 不在框架状态表里，照 R-012/R-020/R-072 用 httpStatus 显式指定。 */
const RULE_STATUS: Readonly<
  Record<MesRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'not-found': { status: 'NOT_FOUND' },
  'code-taken': { status: 'ALREADY_EXISTS' },
  'empty-patch': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'in-use': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'invalid-value': { status: 'INVALID_ARGUMENT' },
};

/** 设计只点名两个规则码；其余是端点自己的普通错误，不与之冲突。 */
const RULE_REASON: Readonly<Record<MesRuleCode, string>> = {
  'not-found': 'MES_NOT_FOUND',
  'code-taken': 'MES_CODE_TAKEN',
  'empty-patch': 'MES_EMPTY_PATCH',
  'in-use': 'MES_SETTING_IN_USE',
  'invalid-value': 'MES_INVALID_VALUE',
};

function mesApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof MesRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  const reason = RULE_REASON[error.code];
  return new ApiError({
    status: rule.status,
    reason,
    domain: 'mesSettings',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`mesSettings.errors.${error.code}`, {
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

const withMappedErrors = async <T>(
  context: MesContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw mesApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/** 一次请求只授权一次；handler 第一行调用，进服务之前就已经结束。 */
async function authorizeMes(
  context: MesContext,
  action: MesAction,
): Promise<MesDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'mesSettings' },
    action,
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

/** 只读判定、不抛错：priceView 决定响应里出不出 unitPrice 这个键。 */
async function hasPriceView(context: MesContext): Promise<boolean> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'mesSettings' },
    action: 'priceView',
  });
  return decision.effect !== 'deny';
}

function priceForbidden(): ApiError {
  return new ApiError({
    status: 'PERMISSION_DENIED',
    reason: 'MES_PRICE_FORBIDDEN',
    domain: 'mesSettings',
    message: 'Reading the operation price requires mesSettings.priceView.',
  });
}

function actorOf(context: MesContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'mesSettings',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const active = z.enum(['active', 'inactive', 'all']);
const optionalId = z.string().min(1).max(64).optional();

export const MesListQuery = z.object({
  active: active.optional(),
  q: z.string().min(1).max(128).optional(),
  page,
  pageSize,
});

export const CreateMesBody = z.object({
  code: z.string().min(1).max(64).optional(),
  name: z.string().min(1).max(128),
  managerUserId: optionalId,
  workerCount: z.number().int().nullable().optional(),
  defaultWorkCenterId: optionalId,
  sortOrder: z.number().int().optional(),
  unitHourlyCapacity: z.number().nullable().optional(),
  equipmentRequired: z.boolean().nullable().optional(),
  handoverConfirm: z.boolean().nullable().optional(),
  inspectionFree: z.boolean().nullable().optional(),
  autoComplete: z.boolean().nullable().optional(),
  currentReportLimit: z.string().max(64).nullable().optional(),
  previousReportLimit: z.string().max(64).nullable().optional(),
  displayStatus: z.string().max(32).optional(),
  productId: optionalId,
});

/** passthrough：路由要先看见不可改的 code/docNo，不能让 zod 静默剥掉。 */
export const UpdateMesBody = CreateMesBody.partial()
  .extend({ active: z.boolean().optional() })
  .passthrough();

export const UpdateRuleBody = z.object({
  value: z.string().min(1).max(128),
});

export const MesPriceQuery = z.object({
  itemId: optionalId,
  operationId: optionalId,
  // 显式索取金额：没有 priceView 时回 403 MES_PRICE_FORBIDDEN。
  includePrice: z.coerce.boolean().default(false),
  page,
  pageSize,
});

export const CreatePriceBody = z.object({
  itemId: z.string().min(1).max(64),
  operationId: z.string().min(1).max(64),
  unitPrice: z.number().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
});

const UPDATE_KEYS: Readonly<Record<MesSettingKind, readonly string[]>> = {
  workCenters: ['name', 'managerUserId', 'workerCount', 'active'],
  operations: [
    'name', 'defaultWorkCenterId', 'sortOrder', 'unitHourlyCapacity',
    'equipmentRequired', 'handoverConfirm', 'inspectionFree', 'autoComplete',
    'currentReportLimit', 'previousReportLimit', 'displayStatus', 'active',
  ],
  processRoutes: ['name', 'productId', 'active'],
  defectItems: ['name', 'active'],
};

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessable = objectResponse(
  z.object({ error: z.object({ reason: z.string(), message: z.string() }) }),
  'The request violates a MES setting rule (422).',
);

const MesItemSchema = z.object({ id: z.string() }).passthrough();
const paged = objectResponse(
  z.object({
    items: z.array(MesItemSchema),
    total: z.number(),
    page: z.number(),
    pageSize: z.number(),
  }),
  'One page of settings.',
);

/**
 * R-023 W3-1 的端点：五个设置各查、建、改，报工规则按 code 改值，工价查与 upsert。
 * 每条 handler 第一行先授权再读请求内容；没有 DELETE 路由，停用在 active；
 * 无 priceView 的会话 GET /operation-prices 仍回 200，但整键去掉 unitPrice（不是 null）。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const settings = app.container.resolve(mesSettingsToken);

    for (const base of [
      '/work-centers', '/work-centers/*',
      '/operations', '/operations/*',
      '/process-routes', '/process-routes/*',
      '/defect-items', '/defect-items/*',
      '/report-rules', '/report-rules/*',
      '/operation-prices', '/operation-prices/*',
    ]) {
      router.use(base, auth.required(), authz.middleware());
    }

    const registerCrud = (
      kind: MesSettingKind,
      path: string,
      tag: string,
      operationPrefix: string,
    ) => {
      router.get(
        path,
        describeRoute({
          tags: [tag],
          summary: `List ${kind}`,
          operationId: `list${operationPrefix}`,
          responses: {
            '200': paged,
            '400': apiErrorResponse(400),
            '401': apiErrorResponse(401),
            '403': apiErrorResponse(403),
            '500': apiErrorResponse(500),
          },
        }),
        apiValidator('query', MesListQuery),
        async (context) => {
          await authorizeMes(context, 'view');
          const query = context.req.valid('query') as MesListQueryType;
          const result = await withMappedErrors(context, () =>
            settings.list(kind, query),
          );
          return context.json({ ...result, page: query.page, pageSize: query.pageSize });
        },
      );

      router.post(
        path,
        describeRoute({
          tags: [tag],
          summary: `Create one ${kind} entry`,
          operationId: `create${operationPrefix}`,
          responses: {
            '201': objectResponse(MesItemSchema, 'The created entry'),
            '400': apiErrorResponse(400),
            '401': apiErrorResponse(401),
            '403': apiErrorResponse(403),
            '409': apiErrorResponse(409),
            '500': apiErrorResponse(500),
          },
        }),
        apiValidator('json', CreateMesBody),
        async (context) => {
          await authorizeMes(context, 'maintain');
          const body = context.req.valid('json') as MesRow;
          const row = await withMappedErrors(context, () =>
            settings.create(kind, body, actorOf(context)),
          );
          return context.json(row, 201);
        },
      );

      router.patch(
        `${path}/:id`,
        describeRoute({
          tags: [tag],
          summary: `Update one ${kind} entry`,
          description:
            'Requires mesSettings.maintain. Only names, ordering, switches and active are editable; deactivating a referenced operation returns 422 MES_SETTING_IN_USE.',
          operationId: `update${operationPrefix}`,
          responses: {
            '200': objectResponse(MesItemSchema, 'The updated entry'),
            '400': apiErrorResponse(400),
            '401': apiErrorResponse(401),
            '403': apiErrorResponse(403),
            '404': apiErrorResponse(404),
            '422': unprocessable,
            '500': apiErrorResponse(500),
          },
        }),
        apiValidator('json', UpdateMesBody),
        async (context) => {
          await authorizeMes(context, 'maintain');
          const body = context.req.valid('json') as MesRow;
          if (
            Object.prototype.hasOwnProperty.call(body, 'code') ||
            Object.prototype.hasOwnProperty.call(body, 'docNo')
          ) {
            throw mesApiError(
              new MesRuleError('invalid-value', 'code'),
              getRequestTranslator(context),
              getRequestLocale(context) ?? 'zh-CN',
            );
          }
          const patch: MesRow = {};
          for (const key of UPDATE_KEYS[kind]) {
            if (Object.prototype.hasOwnProperty.call(body, key)) {
              patch[key] = body[key];
            }
          }
          const row = await withMappedErrors(context, () =>
            settings.update(kind, context.req.param('id'), patch),
          );
          return context.json(row);
        },
      );
    };

    registerCrud('workCenters', '/work-centers', 'MES work centers', 'MesWorkCenter');
    registerCrud('operations', '/operations', 'MES operations', 'MesOperation');
    registerCrud('processRoutes', '/process-routes', 'MES process routes', 'MesProcessRoute');
    registerCrud('defectItems', '/defect-items', 'MES defect items', 'MesDefectItem');

    router.get(
      '/report-rules',
      describeRoute({
        tags: ['MES report rules'],
        summary: 'List the four report rules',
        operationId: 'listMesReportRules',
        responses: {
          '200': paged,
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', MesListQuery),
      async (context) => {
        await authorizeMes(context, 'view');
        const query = context.req.valid('query') as MesListQueryType;
        const result = await withMappedErrors(context, () =>
          settings.list('reportRules', query),
        );
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.patch(
      '/report-rules/:code',
      describeRoute({
        tags: ['MES report rules'],
        summary: 'Update one report rule value',
        operationId: 'updateMesReportRule',
        responses: {
          '200': objectResponse(MesItemSchema, 'The updated rule'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateRuleBody),
      async (context) => {
        await authorizeMes(context, 'maintain');
        const body = context.req.valid('json');
        const row = await withMappedErrors(context, () =>
          settings.updateRule(
            context.req.param('code'),
            body.value,
            actorOf(context),
          ),
        );
        return context.json(row);
      },
    );

    router.get(
      '/operation-prices',
      describeRoute({
        tags: ['MES operation prices'],
        summary: 'List operation prices with the priceView field trimmed',
        description:
          'Requires mesSettings.view. unitPrice is present only when mesSettings.priceView is granted; asking for includePrice without it returns 403 MES_PRICE_FORBIDDEN.',
        operationId: 'listMesOperationPrices',
        responses: {
          '200': paged,
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', MesPriceQuery),
      async (context) => {
        // 读工价窄读动作或设置查看动作任一放行；先授权再读库。
        const canSeePrice = await hasPriceView(context);
        if (!canSeePrice) await authorizeMes(context, 'view');
        const query = context.req.valid<'query'>('query');
        if (query.includePrice && !canSeePrice) throw priceForbidden();
        const result = await withMappedErrors(context, () =>
          settings.listPrices(query),
        );
        const items = result.items.map((item) => {
          if (canSeePrice) return item;
          // 整键不出现，不是 unitPrice: null。
          const { unitPrice: _unitPrice, ...trimmed } = item;
          return trimmed;
        });
        return context.json({ ...result, items, page: query.page, pageSize: query.pageSize });
      },
    );

    router.post(
      '/operation-prices',
      describeRoute({
        tags: ['MES operation prices'],
        summary: 'Upsert the price of one item and operation pair',
        operationId: 'upsertMesOperationPrice',
        responses: {
          '201': objectResponse(MesItemSchema, 'The stored price'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreatePriceBody),
      async (context) => {
        await authorizeMes(context, 'maintain');
        const body = context.req.valid('json') as MesPriceInput;
        const row = await withMappedErrors(context, () =>
          settings.upsertPrice(body, actorOf(context)),
        );
        return context.json(row, 201);
      },
    );

    return new Hono().route('/', router);
  },
);
