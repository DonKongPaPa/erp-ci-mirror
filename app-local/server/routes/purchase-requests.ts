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
  PurchaseRequestRuleError,
  purchaseRequestsServiceToken,
  type PurchaseRequestRuleCode,
} from '../providers/purchase-requests.js';
import {
  ConvertedOrderSchema,
  CreateRequestHeaderBody,
  PurchaseRequestListSchema,
  PurchaseRequestSchema,
  RequestIdParam,
  RequestListQuery,
  SetLinesBody,
  UpdateRequestHeaderBody,
} from './purchase-request-schemas.js';

/**
 * R-021 波 1 加片：请购单八条端点。每条 handler 第一行 authorize，先授权后读内容；
 * 没有 DELETE 路由，作废用 `void`。范围来自授权决策，别人的单与不存在的单都是同一个 404。
 */
type RequestAction =
  | 'view' | 'create' | 'update' | 'submit' | 'void' | 'convert';
type RequestContext = Context<AuthEnv & AuthorizationEnv>;
type RequestDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<PurchaseRequestRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'not-found': { status: 'NOT_FOUND' },
  'not-editable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'no-lines': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-approved': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'converted': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-patch': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'department-not-found': { status: 'NOT_FOUND' },
  'department-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'dict-code-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'approval-failed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

const RULE_REASON: Readonly<Record<PurchaseRequestRuleCode, string>> = {
  'not-found': 'PURCHASE_REQUEST_NOT_FOUND',
  'not-editable': 'PURCHASE_REQUEST_NOT_EDITABLE',
  'no-lines': 'PURCHASE_REQUEST_NO_LINES',
  'not-approved': 'PURCHASE_REQUEST_NOT_APPROVED',
  'converted': 'PURCHASE_REQUEST_CONVERTED',
  'empty-patch': 'PURCHASE_REQUEST_EMPTY_PATCH',
  'line-invalid': 'PURCHASE_REQUEST_LINE_INVALID',
  'item-not-found': 'ITEM_NOT_FOUND',
  'item-inactive': 'ITEM_INACTIVE',
  'department-not-found': 'DEPARTMENT_NOT_FOUND',
  'department-inactive': 'DEPARTMENT_INACTIVE',
  'dict-code-invalid': 'PURCHASE_REQUEST_DICT_CODE_INVALID',
  'person-invalid': 'PURCHASE_REQUEST_PERSON_INVALID',
  'approval-failed': 'PURCHASE_REQUEST_APPROVAL_FAILED',
};

/** 建审批单失败的内部原因码 → 语言包键：内部编码与服务端英文原句都不直接给用户看。 */
const APPROVAL_FAILURE_KEY: Readonly<Record<string, string>> = {
  'no-approver': 'purchaseRequest.errors.approvalFailedNoApprover',
};

const camelOf = (code: PurchaseRequestRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

const unprocessable = objectResponse(
  z.object({ error: z.object({ reason: z.string(), message: z.string() }) }),
  'The request violates a purchase request rule (422).',
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
      domain: 'purchaseRequests',
      message: error.message,
      ...(error.code === 'file-unavailable' ? { httpStatus: 422 as const } : {}),
      cause: error,
    });
  }
  if (!(error instanceof PurchaseRequestRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  // 内部原因码不能原样进用户提示；已知的用专门词条，未知的默认文案仍带 reason。
  const knownKey =
    error.code === 'approval-failed' && error.detail !== undefined
      ? APPROVAL_FAILURE_KEY[error.detail]
      : undefined;
  const messageKey = knownKey ?? `purchaseRequest.errors.${camelOf(error.code)}`;
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'purchaseRequests',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(
        messageKey,
        knownKey === undefined
          ? { reason: error.detail ?? '', defaultValue: error.message }
          : { defaultValue: error.message },
      ),
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

/** 一次请求只授权一次；决策里的数据库范围随后绑到请购单仓储上。 */
async function authorizeRequest(
  context: RequestContext,
  action: RequestAction,
): Promise<RequestDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'purchaseRequests' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

function policyOf(decision: RequestDecision): RepositoryPolicy | undefined {
  return decision.conditions?.database?.['purchaseRequests'];
}

function actorOf(context: RequestContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'purchaseRequests',
      message: 'An authenticated user is required.',
    });
  }
  if ((session.user as { kind?: unknown }).kind === 'service') {
    throw new ApiError({
      status: 'PERMISSION_DENIED',
      reason: 'SERVICE_ACCOUNT_NOT_ALLOWED',
      domain: 'purchaseRequests',
      message: 'Service accounts cannot use purchase request endpoints.',
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
      domain: 'purchaseRequests',
      message: 'The request origin is not trusted for a cookie-authenticated write.',
    });
  }
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const service = app.container.resolve(purchaseRequestsServiceToken);

    router.use('/purchase-requests', auth.required(), authz.middleware());
    router.use('/purchase-requests/*', auth.required(), authz.middleware());

    router.get(
      '/purchase-requests',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'List purchase requests',
        operationId: 'listPurchaseRequests',
        responses: {
          '200': objectResponse(PurchaseRequestListSchema, 'One page of requests'),
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
            requesterUserId: query.mine === true ? actor : query.requesterUserId,
          }, policyOf(decision)),
        );
        return context.json(result);
      },
    );

    router.get(
      '/purchase-requests/:id',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'Read one purchase request',
        operationId: 'getPurchaseRequest',
        responses: {
          '200': objectResponse(PurchaseRequestSchema, 'The request with lines and files'),
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
            new PurchaseRequestRuleError('not-found'),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      '/purchase-requests',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'Create a draft purchase request',
        operationId: 'createPurchaseRequest',
        responses: {
          '201': objectResponse(PurchaseRequestSchema, 'The created draft'),
          ...errorResponses,
        },
      }),
      apiValidator('json', CreateRequestHeaderBody),
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
      '/purchase-requests/:id',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'Update a draft or rejected purchase request',
        operationId: 'updatePurchaseRequest',
        responses: {
          '200': objectResponse(PurchaseRequestSchema, 'The updated request'),
          ...errorResponses,
        },
      }),
      apiValidator('param', RequestIdParam),
      apiValidator('json', UpdateRequestHeaderBody),
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
      '/purchase-requests/:id/lines',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'Replace or append the lines of a purchase request',
        operationId: 'setPurchaseRequestLines',
        responses: {
          '200': objectResponse(PurchaseRequestSchema, 'The request with its lines'),
          ...errorResponses,
        },
      }),
      apiValidator('param', RequestIdParam),
      apiValidator('json', SetLinesBody),
      async (context) => {
        const decision = await authorizeRequest(context, 'update');
        requireOrigin(context);
        const { id } = context.req.valid('param');
        const updated = await withMappedErrors(context, () =>
          service.setLines(id, context.req.valid('json'), policyOf(decision)),
        );
        return context.json(updated);
      },
    );

    router.post(
      '/purchase-requests/:id/submit',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'Submit a purchase request into approval',
        operationId: 'submitPurchaseRequest',
        responses: {
          '200': objectResponse(PurchaseRequestSchema, 'The approving request'),
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
      '/purchase-requests/:id/void',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'Void a purchase request',
        operationId: 'voidPurchaseRequest',
        responses: {
          '200': objectResponse(PurchaseRequestSchema, 'The void request'),
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
      '/purchase-requests/:id/create-order',
      describeRoute({
        tags: ['Purchase requests'],
        summary: 'Convert an approved purchase request into a draft purchase order',
        operationId: 'convertPurchaseRequest',
        responses: {
          '200': objectResponse(ConvertedOrderSchema, 'The converted request and the order id'),
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
