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
  InspectionListQuery,
  CreateInspectionBody,
  ReceivableQuery,
  UpdateInspectionBody,
} from './iqc-schemas.js';
import { DocFileRuleError } from '../providers/doc-files.js';
import {
  IqcRuleError,
  inspectionMutationsToken,
  inspectionReaderToken,
  type IqcRuleCode,
} from '../providers/iqc.js';

/**
 * R-070 IQC：七个端点。先授权、后取内容：无授权的发非法业务值也是 403。
 * 没有删除路由，作废走状态。仓管只有 receiveView 的窄读，不拿详情。
 */
type IqcAction = 'view' | 'create' | 'update' | 'complete' | 'void' | 'receiveView';
type IqcContext = Context<AuthEnv & AuthorizationEnv>;
type IqcDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<IqcRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'iqc-not-found': { status: 'NOT_FOUND' },
  'iqc-not-pending': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'iqc-duplicate-item': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'iqc-qty-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'iqc-received-exceed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'iqc-not-releasable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'iqc-releasable-exceed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'iqc-order-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'iqc-person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'document-not-found': { status: 'NOT_FOUND' },
};

const RULE_REASON: Readonly<Record<IqcRuleCode, string>> = {
  'iqc-not-found': 'IQC_NOT_FOUND',
  'iqc-not-pending': 'IQC_NOT_PENDING',
  'iqc-duplicate-item': 'IQC_DUPLICATE_ITEM',
  'iqc-qty-invalid': 'IQC_QTY_INVALID',
  'iqc-received-exceed': 'IQC_RECEIVED_EXCEED',
  'iqc-not-releasable': 'IQC_NOT_RELEASABLE',
  'iqc-releasable-exceed': 'IQC_RELEASABLE_EXCEED',
  'iqc-order-invalid': 'IQC_ORDER_INVALID',
  'iqc-person-invalid': 'IQC_PERSON_INVALID',
  'item-not-found': 'ITEM_NOT_FOUND',
  'item-inactive': 'ITEM_INACTIVE',
  'document-not-found': 'FILE_NOT_FOUND',
};

const camelOf = (code: IqcRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

const person = z.object({ userId: z.string(), name: z.string() });
const supplier = z.object({ id: z.string(), code: z.string(), name: z.string() });
const order = z.object({ id: z.string(), orderNo: z.string(), orderDate: z.string() });
const item = z.object({
  id: z.string(), code: z.string(), name: z.string(),
  spec: z.string().nullable(), unitCode: z.string(),
});
const line = z.object({
  id: z.string(), itemId: z.string(), item,
  purchaseQty: z.number(), inspectionTypeCode: z.string(),
  receivedQty: z.number(), inspectionQty: z.number(), qualifiedQty: z.number(),
  unqualifiedQty: z.number(), releasableQty: z.number(), returnQty: z.number(),
  samplingQty: z.number(), samplingQualifiedQty: z.number(),
  lossQty: z.number(), retainedQty: z.number(), note: z.string().nullable(),
});
const summary = z.object({
  id: z.string(), docNo: z.string(), inspectionDate: z.string(),
  status: z.enum(['pending', 'passed', 'partial', 'failed', 'void']),
  purchaseOrder: order, supplier: supplier.nullable(), inspector: person.nullable(),
  remark: z.string(), createdAt: z.string(), updatedAt: z.string(),
});
const InspectionSchema = summary.extend({
  lines: z.array(line),
  files: z.array(z.object({
    id: z.string(), name: z.string(), contentType: z.string(), size: z.number(),
  })),
});
const InspectionListSchema = z.object({
  items: z.array(summary), total: z.number(), page: z.number(), pageSize: z.number(),
});
const receivableLine = z.object({
  inspectionLineId: z.string(), itemId: z.string(), warehouseId: z.string(),
  batchNo: z.string(), releasableQty: z.number(), remainQty: z.number(),
});
const ReceivableSchema = z.object({
  id: z.string(), docNo: z.string(), inspectionDate: z.string(),
  status: z.enum(['passed', 'partial']), purchaseOrderId: z.string(),
  lines: z.array(receivableLine),
});
const ReceivableListSchema = z.object({
  items: z.array(ReceivableSchema), total: z.number(), page: z.number(),
  pageSize: z.number(),
});

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});
const unprocessable = objectResponse(InspectionSchema, 'The request violates an IQC rule (422).');

function iqcApiError(
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
  if (!(error instanceof IqcRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'inspectionOrders',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`iqc.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeIqc(
  context: IqcContext,
  action: IqcAction,
): Promise<IqcDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'inspectionOrders' },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

function actorOf(context: IqcContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'inspectionOrders', message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const withMappedErrors = async <T>(
  context: IqcContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw iqcApiError(
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
  const reader = app.container.resolve(inspectionReaderToken);
  const mutations = app.container.resolve(inspectionMutationsToken);

  for (const base of ['/inspections', '/inspections/*']) {
    router.use(base, auth.required(), authz.middleware());
  }

  // 先授权后读内容：在 zod 校验之前按方法/路径判定动作，无授权的发非法业务值也是 403。
  for (const base of ['/inspections', '/inspections/*']) {
    router.use(base, async (context, next) => {
      const pathname = new URL(context.req.url).pathname;
      const method = context.req.method;
      const action: IqcAction | undefined =
        pathname.endsWith('/receivable-options') ? 'receiveView'
          : method === 'GET' ? 'view'
            : method === 'PATCH' ? 'update'
              : pathname.endsWith('/complete') ? 'complete'
                : pathname.endsWith('/void') ? 'void'
                  : method === 'POST' ? 'create'
                    : undefined;
      if (action !== undefined) {
        const decision = await context.get('authz').authorize({
          resource: { type: 'composite', id: 'inspectionOrders' },
          action,
        });
        if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
      }
      await next();
    });
  }

  router.get(
    '/inspections/receivable-options',
    describeRoute({
      tags: ['Inspections'],
      summary: 'List releasable purchase inspections for warehouse receipts',
      operationId: 'listReleasableInspections',
      responses: {
        '200': objectResponse(ReceivableListSchema, 'One page of releasable inspections'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', ReceivableQuery),
    async (context) => {
      await authorizeIqc(context, 'receiveView');
      const query = context.req.valid('query');
      const result = await reader.receivable(query);
      return context.json({ ...result, page: query.page, pageSize: query.pageSize });
    },
  );

  router.get(
    '/inspections',
    describeRoute({
      tags: ['Inspections'],
      summary: 'List purchase inspections',
      operationId: 'listInspections',
      responses: {
        '200': objectResponse(InspectionListSchema, 'One page of inspections'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', InspectionListQuery),
    async (context) => {
      await authorizeIqc(context, 'view');
      const query = context.req.valid('query');
      const result = await reader.list(query);
      return context.json({ ...result, page: query.page, pageSize: query.pageSize });
    },
  );

  router.get(
    '/inspections/:id',
    describeRoute({
      tags: ['Inspections'],
      summary: 'Read one inspection with its lines',
      operationId: 'readInspection',
      responses: {
        '200': objectResponse(InspectionSchema, 'The inspection with lines'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeIqc(context, 'view');
      const row = await reader.detail(context.req.param('id'));
      if (row === undefined) {
        throw iqcApiError(
          new IqcRuleError('iqc-not-found'),
          getRequestTranslator(context),
          getRequestLocale(context) ?? 'zh-CN',
        );
      }
      return context.json(row);
    },
  );

  router.post(
    '/inspections',
    describeRoute({
      tags: ['Inspections'],
      summary: 'Create a pending purchase inspection',
      operationId: 'createInspection',
      responses: {
        '201': objectResponse(InspectionSchema, 'The created inspection'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', CreateInspectionBody),
    async (context) => {
      await authorizeIqc(context, 'create');
      const row = await withMappedErrors(context, async () =>
        mutations.create(context.req.valid('json'), actorOf(context)),
      );
      return context.json(row, 201);
    },
  );

  router.patch(
    '/inspections/:id',
    describeRoute({
      tags: ['Inspections'],
      summary: 'Replace the lines of a pending inspection',
      operationId: 'updateInspection',
      responses: {
        '200': objectResponse(InspectionSchema, 'The updated inspection'),
        '400': apiErrorResponse(400), '401': apiErrorResponse(401),
        '403': apiErrorResponse(403), '404': apiErrorResponse(404),
        '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    apiValidator('json', UpdateInspectionBody),
    async (context) => {
      await authorizeIqc(context, 'update');
      const row = await withMappedErrors(context, async () =>
        mutations.update(context.req.param('id'), context.req.valid('json'), actorOf(context)),
      );
      return context.json(row);
    },
  );

  router.post(
    '/inspections/:id/complete',
    describeRoute({
      tags: ['Inspections'],
      summary: 'Complete an inspection and compute the derived quantities',
      operationId: 'completeInspection',
      responses: {
        '200': objectResponse(InspectionSchema, 'The completed inspection'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeIqc(context, 'complete');
      const row = await withMappedErrors(context, async () =>
        mutations.complete(context.req.param('id'), actorOf(context)),
      );
      return context.json(row);
    },
  );

  router.post(
    '/inspections/:id/void',
    describeRoute({
      tags: ['Inspections'],
      summary: 'Void a pending inspection',
      operationId: 'voidInspection',
      responses: {
        '200': objectResponse(InspectionSchema, 'The voided inspection'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403),
        '404': apiErrorResponse(404), '422': unprocessable, '500': apiErrorResponse(500),
      },
    }),
    async (context) => {
      await authorizeIqc(context, 'void');
      const row = await withMappedErrors(context, async () =>
        mutations.void(context.req.param('id'), actorOf(context)),
      );
      return context.json(row);
    },
  );

  return new Hono().route('/', router);
});
