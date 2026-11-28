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
import type { RepositoryPolicy } from '@nocobase/db';

import { DocFileRuleError } from '../providers/doc-files.js';
import {
  FinanceRequestRuleError,
  financeRequestsServiceToken,
  type FinanceRequestRuleCode,
} from '../providers/finance-requests.js';
import {
  ConvertedSchema,
  CreateFinanceRequestBody,
  FinanceRequestListSchema,
  FinanceRequestSchema,
  RequestIdParam,
  RequestListQuery,
  UpdateFinanceRequestBody,
} from './finance-request-schemas.js';

/**
 * R-066：请款单与报销单七条端点。每条 handler 第一行 authorize，先授权后读内容；
 * 没有 DELETE 路由，作废用 void。范围来自授权决策，别人的单与不存在的单都是同一个 404。
 */
type RequestAction = 'view' | 'create' | 'update' | 'submit' | 'void' | 'convert';
type RequestContext = Context<AuthEnv & AuthorizationEnv>;
type RequestDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<FinanceRequestRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'not-found': { status: 'NOT_FOUND' },
  'not-editable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'amount-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'dict-code-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-approved': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'converted': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'approval-failed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

const RULE_REASON: Readonly<Record<FinanceRequestRuleCode, string>> = {
  'not-found': 'FINANCE_REQUEST_NOT_FOUND',
  'not-editable': 'FINANCE_REQUEST_NOT_EDITABLE',
  'amount-invalid': 'FINANCE_REQUEST_AMOUNT_INVALID',
  'person-invalid': 'FINANCE_REQUEST_PERSON_INVALID',
  'dict-code-invalid': 'FINANCE_REQUEST_DICT_CODE_INVALID',
  'not-approved': 'FINANCE_REQUEST_NOT_APPROVED',
  'converted': 'FINANCE_REQUEST_CONVERTED',
  'approval-failed': 'FINANCE_REQUEST_APPROVAL_FAILED',
};

const camelOf = (code: FinanceRequestRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessable = objectResponse(
  z.object({ error: z.object({ reason: z.string(), message: z.string() }) }),
  'The request violates a finance request rule (422).',
);

const errorResponses = {
  '400': apiErrorResponse(400),
  '401': apiErrorResponse(401),
  '403': apiErrorResponse(403),
  '404': apiErrorResponse(404),
  '422': unprocessable,
  '500': apiErrorResponse(500),
} as const;

function requestApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (error instanceof DocFileRuleError) {
    const status = error.code === 'file-not-found'
      ? 'NOT_FOUND'
      : error.code === 'file-unavailable'
        ? 'FAILED_PRECONDITION'
        : 'INVALID_ARGUMENT';
    return new ApiError({
      status,
      reason: error.code === 'file-not-found'
        ? 'FILE_NOT_FOUND'
        : error.code === 'file-unavailable'
          ? 'FILE_UNAVAILABLE'
          : 'FILE_TOO_MANY',
      domain: 'financeRequests',
      message: error.message,
      ...(error.code === 'file-unavailable' ? { httpStatus: 422 as const } : {}),
      cause: error,
    });
  }
  if (!(error instanceof FinanceRequestRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'financeRequests',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`financeRequest.errors.${camelOf(error.code)}`, {
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
  context: RequestContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw requestApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/** 一次请求只授权一次；决策里的数据库范围随后绑到请款单仓储上。 */
async function authorizeRequest(
  context: RequestContext,
  action: RequestAction,
): Promise<RequestDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'financeRequests' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

function policyOf(decision: RequestDecision): RepositoryPolicy | undefined {
  return decision.conditions?.database?.['financeRequestDocs'];
}

function actorOf(context: RequestContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'financeRequests',
      message: 'An authenticated user is required.',
    });
  }
  if ((session.user as { kind?: unknown }).kind === 'service') {
    throw new ApiError({
      status: 'PERMISSION_DENIED',
      reason: 'SERVICE_ACCOUNT_NOT_ALLOWED',
      domain: 'financeRequests',
      message: 'Service accounts cannot use finance request endpoints.',
    });
  }
  return String(session.user.id);
}

function requireOrigin(context: RequestContext): void {
  const origin = context.req.header('origin');
  if (origin === undefined || origin.trim().length === 0) {
    throw new ApiError({
      status: 'PERMISSION_DENIED',
      reason: 'INVALID_CSRF_ORIGIN',
      domain: 'financeRequests',
      message: 'The request origin is not trusted for a cookie-authenticated write.',
    });
  }
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const service = app.container.resolve(financeRequestsServiceToken);

    router.use('/finance-requests', auth.required(), authz.middleware());
    router.use('/finance-requests/*', auth.required(), authz.middleware());

    router.get(
      '/finance-requests',
      describeRoute({
        tags: ['Finance requests'],
        summary: 'List payment requests and expense claims',
        operationId: 'listFinanceRequests',
        responses: {
          '200': objectResponse(FinanceRequestListSchema, 'One page of requests'),
          ...errorResponses,
        },
      }),
      apiValidator('query', RequestListQuery),
      async (context) => {
        const decision = await authorizeRequest(context, 'view');
        const actor = actorOf(context);
        const query = context.req.valid('query');
        const result = await withMappedErrors(context, () =>
          service.list({
            ...query,
            mineOwnerId: query.mine === true ? actor : undefined,
          }, policyOf(decision)),
        );
        return context.json(result);
      },
    );

    router.get(
      '/finance-requests/:id',
      describeRoute({
        tags: ['Finance requests'],
        summary: 'Read one finance request',
        operationId: 'getFinanceRequest',
        responses: {
          '200': objectResponse(FinanceRequestSchema, 'The request with labels and files'),
          ...errorResponses,
        },
      }),
      apiValidator('param', RequestIdParam),
      async (context) => {
        const decision = await authorizeRequest(context, 'view');
        const { id } = context.req.valid('param');
        const row = await withMappedErrors(context, () =>
          service.detail(id, policyOf(decision)),
        );
        if (row === undefined) {
          throw requestApiError(
            new FinanceRequestRuleError('not-found'),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      '/finance-requests',
      describeRoute({
        tags: ['Finance requests'],
        summary: 'Create a draft finance request',
        operationId: 'createFinanceRequest',
        responses: {
          '201': objectResponse(FinanceRequestSchema, 'The created draft'),
          ...errorResponses,
        },
      }),
      apiValidator('json', CreateFinanceRequestBody),
      async (context) => {
        await authorizeRequest(context, 'create');
        requireOrigin(context);
        const actor = actorOf(context);
        const created = await withMappedErrors(context, () =>
          service.create(context.req.valid('json'), { id: actor }),
        );
        return context.json(created, 201);
      },
    );

    router.patch(
      '/finance-requests/:id',
      describeRoute({
        tags: ['Finance requests'],
        summary: 'Update a draft or rejected finance request',
        operationId: 'updateFinanceRequest',
        responses: {
          '200': objectResponse(FinanceRequestSchema, 'The updated request'),
          ...errorResponses,
        },
      }),
      apiValidator('param', RequestIdParam),
      apiValidator('json', UpdateFinanceRequestBody),
      async (context) => {
        const decision = await authorizeRequest(context, 'update');
        requireOrigin(context);
        const actor = actorOf(context);
        const { id } = context.req.valid('param');
        const updated = await withMappedErrors(context, () =>
          service.update(id, context.req.valid('json'), { id: actor }, policyOf(decision)),
        );
        return context.json(updated);
      },
    );

    router.post(
      '/finance-requests/:id/submit',
      describeRoute({
        tags: ['Finance requests'],
        summary: 'Submit a finance request into approval',
        operationId: 'submitFinanceRequest',
        responses: {
          '200': objectResponse(FinanceRequestSchema, 'The approving request'),
          ...errorResponses,
        },
      }),
      apiValidator('param', RequestIdParam),
      async (context) => {
        const decision = await authorizeRequest(context, 'submit');
        requireOrigin(context);
        const actor = actorOf(context);
        const { id } = context.req.valid('param');
        const submitted = await withMappedErrors(context, () =>
          service.submit(id, { id: actor }, policyOf(decision)),
        );
        return context.json(submitted);
      },
    );

    router.post(
      '/finance-requests/:id/void',
      describeRoute({
        tags: ['Finance requests'],
        summary: 'Void a draft finance request',
        operationId: 'voidFinanceRequest',
        responses: {
          '200': objectResponse(FinanceRequestSchema, 'The void request'),
          ...errorResponses,
        },
      }),
      apiValidator('param', RequestIdParam),
      async (context) => {
        const decision = await authorizeRequest(context, 'void');
        requireOrigin(context);
        const { id } = context.req.valid('param');
        const voided = await withMappedErrors(context, () =>
          service.void(id, policyOf(decision)),
        );
        return context.json(voided);
      },
    );

    router.post(
      '/finance-requests/:id/create-expense',
      describeRoute({
        tags: ['Finance requests'],
        summary: 'Convert an approved finance request into a draft expense record',
        operationId: 'convertFinanceRequest',
        responses: {
          '200': objectResponse(ConvertedSchema, 'The converted request and the expense id'),
          ...errorResponses,
        },
      }),
      apiValidator('param', RequestIdParam),
      async (context) => {
        const decision = await authorizeRequest(context, 'convert');
        requireOrigin(context);
        const actor = actorOf(context);
        const { id } = context.req.valid('param');
        const converted = await withMappedErrors(context, () =>
          service.convert(id, { id: actor }, policyOf(decision)),
        );
        return context.json(converted);
      },
    );

    return new Hono().route('/', router);
  },
);
