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
  orderLedgerToken,
  type LedgerQuery,
  type ReminderQuery,
} from '../providers/order-ledger.js';
import {
  orderReviewMutationsToken,
  orderReviewReaderToken,
  ReviewRuleError,
  type ReviewRuleCode,
} from '../providers/order-reviews.js';
import {
  ConfirmDeliveryBody,
  CreateReviewBody,
  LedgerListSchema,
  LedgerListQuery,
  OrderReviewSchema,
  ReminderListQuery,
  ReminderListSchema,
  ReviewListQuery,
  ReviewListSchema,
  UpdateReviewBody,
} from './order-review-schemas.js';

/**
 * R-064 的九条端点：评审七条、总台账一条、首页交付提醒一条。
 *
 * 每条 handler 第一行就是 authorize：无授权的人即使带上业务上非法的请求体也先得 403，
 * 服务层根本不会被调用。没有 DELETE 路由，停用与替代都走 void。
 * 台账与提醒授权失败用设计里的 LEDGER_FORBIDDEN，不先去库里取订单。
 */
type ReviewAction =
  | 'view' | 'create' | 'update' | 'submit' | 'confirm' | 'void';
type ReviewContext = Context<AuthEnv & AuthorizationEnv>;
type ReviewDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<ReviewRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'not-found': { status: 'NOT_FOUND' },
  'not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-submitted': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'factors-incomplete': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'delivery-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'order-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'confirmed-exists': { status: 'ALREADY_EXISTS' },
};

const RULE_REASON: Readonly<Record<ReviewRuleCode, string>> = {
  'not-found': 'REVIEW_NOT_FOUND',
  'not-draft': 'REVIEW_NOT_DRAFT',
  'not-submitted': 'REVIEW_NOT_SUBMITTED',
  'factors-incomplete': 'REVIEW_FACTORS_INCOMPLETE',
  'person-invalid': 'REVIEW_PERSON_INVALID',
  'delivery-invalid': 'REVIEW_DELIVERY_INVALID',
  'order-invalid': 'REVIEW_ORDER_INVALID',
  'confirmed-exists': 'REVIEW_CONFIRMED_EXISTS',
};

const camelOf = (code: ReviewRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessable = objectResponse(
  z.object({ error: z.object({ reason: z.string(), message: z.string() }) }),
  'The request violates a review rule (422).',
);

function reviewApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (!(error instanceof ReviewRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'orderReviews',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`orderReview.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

const withMappedErrors = async <T>(
  context: ReviewContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw reviewApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/** 一次请求只授权一次，handler 第一行调用，进服务之前已经结束。 */
async function authorizeReview(
  context: ReviewContext,
  action: ReviewAction,
): Promise<ReviewDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'orderReviews' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

async function authorizeLedger(context: ReviewContext): Promise<ReviewDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'salesOrders' },
    action: 'ledgerView',
  });
  if (decision.effect === 'deny') {
    throw new ApiError({
      status: 'PERMISSION_DENIED',
      reason: 'LEDGER_FORBIDDEN',
      domain: 'orderLedger',
      message: 'No ledgerView permission on sales orders.',
    });
  }
  return decision;
}

/** auth.required() 已挡过未登录；这里是类型收窄的兜底。 */
function actorOf(context: ReviewContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'orderReviews',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reviews = app.container.resolve(orderReviewReaderToken);
    const mutations = app.container.resolve(orderReviewMutationsToken);
    const ledger = app.container.resolve(orderLedgerToken);

    for (const base of [
      '/order-reviews',
      '/order-reviews/*',
      '/sales-orders/ledger',
      '/home/delivery-reminders',
    ]) {
      router.use(base, auth.required(), authz.middleware());
    }

    router.get(
      '/order-reviews',
      describeRoute({
        tags: ['Order reviews'],
        summary: 'List order reviews',
        operationId: 'listOrderReviews',
        responses: {
          '200': objectResponse(ReviewListSchema, 'One page of reviews without lines'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ReviewListQuery),
      async (context) => {
        await authorizeReview(context, 'view');
        const query = context.req.valid('query');
        const result = await withMappedErrors(context, () => reviews.list(query));
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      '/order-reviews/:id',
      describeRoute({
        tags: ['Order reviews'],
        summary: 'Read one order review with its five factors',
        operationId: 'readOrderReview',
        responses: {
          '200': objectResponse(OrderReviewSchema, 'The review with lines and order summary'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeReview(context, 'view');
        const row = await withMappedErrors(context, () =>
          reviews.detail(context.req.param('id')),
        );
        if (row === undefined) {
          throw reviewApiError(
            new ReviewRuleError('not-found', context.req.param('id')),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      '/order-reviews',
      describeRoute({
        tags: ['Order reviews'],
        summary: 'Create a draft review with exactly five factors',
        operationId: 'createOrderReview',
        responses: {
          '201': objectResponse(OrderReviewSchema, 'The created draft with lines'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateReviewBody),
      async (context) => {
        await authorizeReview(context, 'create');
        const body = context.req.valid('json');
        const row = await withMappedErrors(context, () =>
          mutations.create(body, actorOf(context)),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      '/order-reviews/:id',
      describeRoute({
        tags: ['Order reviews'],
        summary: 'Update a draft review; lines are replaced as a whole',
        operationId: 'updateOrderReview',
        responses: {
          '200': objectResponse(OrderReviewSchema, 'The updated review'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateReviewBody),
      async (context) => {
        await authorizeReview(context, 'update');
        const body = context.req.valid('json');
        const row = await withMappedErrors(context, () =>
          mutations.update(context.req.param('id'), body),
        );
        return context.json(row);
      },
    );

    router.post(
      '/order-reviews/:id/submit',
      describeRoute({
        tags: ['Order reviews'],
        summary: 'Submit a draft review and stamp the review time',
        operationId: 'submitOrderReview',
        responses: {
          '200': objectResponse(OrderReviewSchema, 'The submitted review'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeReview(context, 'submit');
        const row = await withMappedErrors(context, () =>
          mutations.submit(context.req.param('id')),
        );
        return context.json(row);
      },
    );

    router.post(
      '/order-reviews/:id/confirm',
      describeRoute({
        tags: ['Order reviews'],
        summary: 'Confirm the delivery date and void the previous confirmed review',
        operationId: 'confirmOrderReview',
        responses: {
          '200': objectResponse(OrderReviewSchema, 'The confirmed review'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessable,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', ConfirmDeliveryBody),
      async (context) => {
        await authorizeReview(context, 'confirm');
        const body = context.req.valid('json');
        const row = await withMappedErrors(context, () =>
          mutations.confirm(context.req.param('id'), body.confirmedDeliveryDate),
        );
        return context.json(row);
      },
    );

    router.post(
      '/order-reviews/:id/void',
      describeRoute({
        tags: ['Order reviews'],
        summary: 'Void a review instead of deleting it',
        operationId: 'voidOrderReview',
        responses: {
          '200': objectResponse(OrderReviewSchema, 'The voided review'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeReview(context, 'void');
        const row = await withMappedErrors(context, () =>
          mutations.void(context.req.param('id')),
        );
        return context.json(row);
      },
    );

    router.get(
      '/sales-orders/ledger',
      describeRoute({
        tags: ['Order ledger'],
        summary: 'Read the narrow sales order progress ledger',
        description: 'Requires salesOrders.ledgerView. Never returns prices, amounts or contact details; segments without a data source are null.',
        operationId: 'listSalesOrderLedger',
        responses: {
          '200': objectResponse(LedgerListSchema, 'One page of ledger rows'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', LedgerListQuery),
      async (context) => {
        await authorizeLedger(context);
        const query = context.req.valid('query') as LedgerQuery;
        const result = await ledger.list(query);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      '/home/delivery-reminders',
      describeRoute({
        tags: ['Order ledger'],
        summary: 'Read overdue or upcoming delivery reminders',
        description: 'Requires salesOrders.ledgerView. Sorted by baselineDate ascending, at most 100 rows.',
        operationId: 'listDeliveryReminders',
        responses: {
          '200': objectResponse(ReminderListSchema, 'Reminders and their total'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ReminderListQuery),
      async (context) => {
        await authorizeLedger(context);
        const query = context.req.valid('query') as ReminderQuery;
        return context.json(await ledger.reminders(query));
      },
    );

    return new Hono().route('/', router);
  },
);
