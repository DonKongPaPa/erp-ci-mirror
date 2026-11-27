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
  CreateShiftBody,
  ShiftListQuery,
  ShiftListSchema,
  ShiftSchema,
  UpdateShiftBody,
} from './schemas.js';
import {
  ShiftRuleError,
  shiftMutationsToken,
  shiftReaderToken,
  type ShiftRuleCode,
} from '../providers/shifts.js';

type ShiftAction = 'view' | 'manage';
type ShiftContext = Context<AuthEnv & AuthorizationEnv>;
type ShiftDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 422 不在框架状态表里，和 R-012 一样用 httpStatus 显式指定。 */
const RULE_STATUS: Readonly<
  Record<ShiftRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'invalid-code': { status: 'INVALID_ARGUMENT' },
  'invalid-title': { status: 'INVALID_ARGUMENT' },
  'invalid-minute': { status: 'INVALID_ARGUMENT' },
  'invalid-break': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-range': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'break-out-of-range': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'code-exists': { status: 'ALREADY_EXISTS' },
  'shift-not-found': { status: 'NOT_FOUND' },
  'invalid-update': { status: 'INVALID_ARGUMENT' },
  'field-immutable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'already-inactive': { status: 'ABORTED' },
  'already-active': { status: 'ABORTED' },
};

const reasonOf = (code: ShiftRuleCode): string =>
  `SHIFT_${code.replaceAll('-', '_').toUpperCase()}`;

const camelOf = (code: ShiftRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessableResponse = objectResponse(
  ShiftSchema,
  'The request violates a shift rule (422).',
);

function shiftApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof ShiftRuleError)) {
    throw error;
  }
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: reasonOf(error.code),
    domain: 'shifts',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`shifts.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeShifts(
  context: ShiftContext,
  action: ShiftAction,
): Promise<ShiftDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'shifts' },
    action,
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

function missingShift(): ApiError {
  return new ApiError({
    status: 'NOT_FOUND',
    reason: 'SHIFT_NOT_FOUND',
    domain: 'shifts',
    message: 'The shift does not exist.',
  });
}

function emptyPatch(): ApiError {
  return new ApiError({
    status: 'INVALID_ARGUMENT',
    reason: 'INVALID_INPUT',
    domain: 'shifts',
    message: 'At least one of title or sortOrder is required.',
  });
}

const withMappedErrors = async <T>(
  context: ShiftContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw shiftApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/** PATCH 的请求体里不该出现这些键；出现就 422，不静默忽略。 */
const IMMUTABLE_KEYS = [
  'id',
  'startMinute',
  'endMinute',
  'breakStartMinute',
  'breakEndMinute',
  'active',
] as const;

/**
 * R-025 的六个端点：读给 `shifts.view`，写给 `shifts.manage`，没有删除。
 * Origin 由 `auth.required()` 在写端点校验；授权在 handler 第一行、进服务之前完成，
 * 所以无授权的人发一个编码重复的请求得到 403 而不是 409。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(shiftReaderToken);
    const mutations = app.container.resolve(shiftMutationsToken);

    for (const base of ['/shifts', '/shifts/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/shifts',
      describeRoute({
        tags: ['Shifts'],
        summary: 'List shift definitions',
        description:
          'Requires shifts.view. Active shifts only unless includeInactive=true; sorted by sortOrder then code. Paginated 20 per page, at most 100.',
        operationId: 'listShifts',
        responses: {
          '200': objectResponse(ShiftListSchema, 'One page of shifts'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ShiftListQuery),
      async (context) => {
        await authorizeShifts(context, 'view');
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

    router.post(
      '/shifts',
      describeRoute({
        tags: ['Shifts'],
        summary: 'Create a shift definition',
        description:
          'Requires shifts.manage. The code is final, globally unique and never reused. Times are integer minutes from midnight; end before start means cross-midnight. No delete route exists.',
        operationId: 'createShift',
        responses: {
          '201': objectResponse(ShiftSchema, 'The created shift'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateShiftBody),
      async (context) => {
        await authorizeShifts(context, 'manage');
        const row = await withMappedErrors(context, async () =>
          mutations.create(context.req.valid('json')),
        );
        return context.json(row, 201);
      },
    );

    router.post(
      '/shifts/:id/deactivate',
      describeRoute({
        tags: ['Shifts'],
        summary: 'Deactivate a shift',
        operationId: 'deactivateShift',
        responses: {
          '200': objectResponse(ShiftSchema, 'The deactivated shift'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeShifts(context, 'manage');
        const row = await withMappedErrors(context, async () =>
          mutations.setActive(context.req.param('id'), false),
        );
        return context.json(row);
      },
    );

    router.post(
      '/shifts/:id/activate',
      describeRoute({
        tags: ['Shifts'],
        summary: 'Reactivate a deactivated shift',
        operationId: 'activateShift',
        responses: {
          '200': objectResponse(ShiftSchema, 'The activated shift'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeShifts(context, 'manage');
        const row = await withMappedErrors(context, async () =>
          mutations.setActive(context.req.param('id'), true),
        );
        return context.json(row);
      },
    );

    router.patch(
      '/shifts/:id',
      describeRoute({
        tags: ['Shifts'],
        summary: 'Rename or reorder a shift',
        description:
          'Requires shifts.manage. Only title and sortOrder may change; the code, times and break are immutable (422). Times change by creating a new shift and deactivating this one.',
        operationId: 'updateShift',
        responses: {
          '200': objectResponse(ShiftSchema, 'The updated shift'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateShiftBody),
      async (context) => {
        await authorizeShifts(context, 'manage');
        const body = context.req.valid('json');
        const immutable = IMMUTABLE_KEYS.filter((key) =>
          Object.prototype.hasOwnProperty.call(body, key),
        );
        if (immutable.length > 0) {
          throw shiftApiError(
            new ShiftRuleError(
              'field-immutable',
              immutable.join(', '),
            ),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        if (body.title === undefined && body.sortOrder === undefined) {
          throw emptyPatch();
        }
        const row = await withMappedErrors(context, async () =>
          mutations.update(context.req.param('id'), body),
        );
        return context.json(row);
      },
    );

    router.get(
      '/shifts/:id',
      describeRoute({
        tags: ['Shifts'],
        summary: 'Read one shift, including deactivated ones',
        operationId: 'readShift',
        responses: {
          '200': objectResponse(ShiftSchema, 'The shift'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeShifts(context, 'view');
        const row = await reader.detail(context.req.param('id'));
        if (row === undefined) {
          throw missingShift();
        }
        return context.json(row);
      },
    );

    return new Hono().route('/', router);
  },
);
