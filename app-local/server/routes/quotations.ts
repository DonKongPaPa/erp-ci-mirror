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

import { DocFileRuleError } from '../providers/doc-files.js';
import {
  QuotationRuleError,
  quotationMutationsToken,
  quotationReaderToken,
  type QuotationRuleCode,
} from '../providers/quotations.js';
import {
  ConvertResultSchema,
  CreateQuotationBody,
  QuotationListQuery,
  QuotationListSchema,
  QuotationSchemaOut,
  UpdateQuotationBody,
} from './quotation-schemas.js';

/** R-022 复刻波 1：七条报价端点，先授权、后读内容。没有 DELETE 路由。 */
type QuotationAction = 'view' | 'create' | 'update' | 'confirm' | 'convert' | 'void';
type QuotationContext = Context<AuthEnv & AuthorizationEnv>;
type QuotationDecision = AuthorizationDecision<CompositeResourceConditions>;

const RESOURCE_ID = 'quotations';
const TAG = 'Quotations';

const RULE_STATUS: Readonly<
  Record<QuotationRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'quotation-not-found': { status: 'NOT_FOUND' },
  'not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-confirmed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  converted: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  empty: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'validity-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'discount-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'customer-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'dict-code-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

const RULE_REASON: Readonly<Record<QuotationRuleCode, string>> = {
  'quotation-not-found': 'QUOTATION_NOT_FOUND',
  'not-draft': 'QUOTATION_NOT_DRAFT',
  'not-confirmed': 'QUOTATION_NOT_CONFIRMED',
  converted: 'QUOTATION_CONVERTED',
  empty: 'QUOTATION_EMPTY',
  'validity-invalid': 'QUOTATION_VALIDITY_INVALID',
  'discount-invalid': 'QUOTATION_DISCOUNT_INVALID',
  'line-invalid': 'QUOTATION_LINE_INVALID',
  'customer-invalid': 'QUOTATION_CUSTOMER_INVALID',
  'dict-code-invalid': 'QUOTATION_DICT_CODE_INVALID',
  'person-invalid': 'QUOTATION_PERSON_INVALID',
};

const camelOf = (code: string): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

function quotationApiError(
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
      domain: 'docFiles',
      message: error.message,
      ...(status === 'FAILED_PRECONDITION' ? { httpStatus: 422 as const } : {}),
      cause: error,
    });
  }
  if (!(error instanceof QuotationRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[error.code],
    domain: 'quotations',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`quotations.errors.${camelOf(error.code)}`, {
        reason: error.detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: error.detail === undefined ? undefined : { reason: error.detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeQuotation(
  context: QuotationContext,
  action: QuotationAction,
): Promise<QuotationDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: RESOURCE_ID },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

function actorOf(context: QuotationContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'quotations',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const withMappedErrors = async <T>(
  context: QuotationContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw quotationApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

interface QuotationBody {
  quoteDate?: string | null;
  validUntil?: string | null;
  warehouseId?: string | null;
  customerId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  deliveryAddress?: string | null;
  projectCode?: string | null;
  settlementCode?: string | null;
  customerOrderNo?: string | null;
  handlerUserId?: string | null;
  discountAmount?: number;
  fileIds?: string[];
  lines?: {
    itemId: string; qty: number; price?: number | null; taxExcludedPrice?: number | null;
    taxRate?: number | null; deliveryDate?: string | null; note?: string | null;
  }[];
}

/** R-022 复刻波 1：报价单七条端点。 */
export function createQuotationApiRoutes(): AppApiRouteContribution<Application> {
  return defineApiRoutes((app) => {
    const base = '/quotations';
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(quotationReaderToken);
    const mutations = app.container.resolve(quotationMutationsToken);

    for (const route of [base, `${base}/*`]) {
      router.use(route, auth.required(), authz.middleware());
    }

    router.get(
      base,
      describeRoute({
        tags: [TAG],
        summary: 'List quotations',
        operationId: 'listQuotations',
        responses: {
          '200': objectResponse(QuotationListSchema, 'One page of quotation summaries'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', QuotationListQuery),
      async (context) => {
        await authorizeQuotation(context, 'view');
        const query = context.req.valid('query');
        const result = await reader.list({
          ...(query.customerId === undefined ? {} : { customerId: query.customerId }),
          ...(query.projectCode === undefined ? {} : { projectCode: query.projectCode }),
          ...(query.status === undefined ? {} : { status: query.status }),
          validFrom: query.validFrom,
          validTo: query.validTo,
          q: query.q,
          page: query.page,
          pageSize: query.pageSize,
        });
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      `${base}/:id`,
      describeRoute({
        tags: [TAG],
        summary: 'Read one quotation with its lines, attachments and summaries',
        operationId: 'readQuotation',
        responses: {
          '200': objectResponse(QuotationSchemaOut, 'The quotation'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeQuotation(context, 'view');
        const row = await withMappedErrors(context, async () =>
          reader.detail(context.req.param('id')),
        );
        if (row === undefined) {
          throw quotationApiError(
            new QuotationRuleError('quotation-not-found'),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      base,
      describeRoute({
        tags: [TAG],
        summary: 'Create a draft quotation with lines',
        description: 'The document number comes from the code service in the same transaction; the six totals are always computed by the server.',
        operationId: 'createQuotation',
        responses: {
          '201': objectResponse(QuotationSchemaOut, 'The created draft quotation'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(QuotationSchemaOut, 'The request violates a quotation rule'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateQuotationBody),
      async (context) => {
        await authorizeQuotation(context, 'create');
        const body = context.req.valid('json') as QuotationBody;
        const row = await withMappedErrors(context, async () =>
          mutations.create({
            quoteDate: body.quoteDate,
            validUntil: body.validUntil,
            warehouseId: body.warehouseId,
            customerId: body.customerId,
            contactName: body.contactName,
            contactPhone: body.contactPhone,
            deliveryAddress: body.deliveryAddress,
            projectCode: body.projectCode,
            settlementCode: body.settlementCode,
            customerOrderNo: body.customerOrderNo,
            handlerUserId: body.handlerUserId,
            discountAmount: body.discountAmount,
            fileIds: body.fileIds,
            lines: body.lines ?? [],
          }, actorOf(context)),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      `${base}/:id`,
      describeRoute({
        tags: [TAG],
        summary: 'Replace the lines of a draft quotation',
        description: 'Drafts only; a supplied line list replaces the whole list. Server-owned totals are ignored.',
        operationId: 'updateQuotation',
        responses: {
          '200': objectResponse(QuotationSchemaOut, 'The updated quotation'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(QuotationSchemaOut, 'The request violates a quotation rule'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateQuotationBody),
      async (context) => {
        await authorizeQuotation(context, 'update');
        const body = context.req.valid('json') as QuotationBody;
        const row = await withMappedErrors(context, async () =>
          mutations.update(context.req.param('id'), {
            quoteDate: body.quoteDate,
            validUntil: body.validUntil,
            warehouseId: body.warehouseId,
            customerId: body.customerId,
            contactName: body.contactName,
            contactPhone: body.contactPhone,
            deliveryAddress: body.deliveryAddress,
            projectCode: body.projectCode,
            settlementCode: body.settlementCode,
            customerOrderNo: body.customerOrderNo,
            handlerUserId: body.handlerUserId,
            discountAmount: body.discountAmount,
            fileIds: body.fileIds,
            lines: body.lines,
          }, actorOf(context)),
        );
        return context.json(row);
      },
    );

    router.post(
      `${base}/:id/confirm`,
      describeRoute({
        tags: [TAG],
        summary: 'Confirm a draft quotation',
        operationId: 'confirmQuotation',
        responses: {
          '200': objectResponse(QuotationSchemaOut, 'The confirmed quotation'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(QuotationSchemaOut, 'QUOTATION_NOT_CONFIRMED or QUOTATION_EMPTY'),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeQuotation(context, 'confirm');
        const row = await withMappedErrors(context, async () =>
          mutations.confirm(context.req.param('id')),
        );
        return context.json(row);
      },
    );

    router.post(
      `${base}/:id/create-sales-order`,
      describeRoute({
        tags: [TAG],
        summary: 'Convert a confirmed quotation into one draft sales order',
        description: 'Manual, full, once. Draft, void and already-converted quotations are refused.',
        operationId: 'createSalesOrderFromQuotation',
        responses: {
          '200': objectResponse(ConvertResultSchema, 'The quotation and the new sales order id'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(ConvertResultSchema, 'QUOTATION_NOT_CONFIRMED or QUOTATION_CONVERTED'),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeQuotation(context, 'convert');
        const row = await withMappedErrors(context, async () =>
          mutations.convert(context.req.param('id'), actorOf(context)),
        );
        return context.json(row);
      },
    );

    router.post(
      `${base}/:id/void`,
      describeRoute({
        tags: [TAG],
        summary: 'Void a draft or confirmed quotation',
        operationId: 'voidQuotation',
        responses: {
          '200': objectResponse(QuotationSchemaOut, 'The voided quotation'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(QuotationSchemaOut, 'QUOTATION_NOT_CONFIRMED'),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeQuotation(context, 'void');
        const row = await withMappedErrors(context, async () =>
          mutations.void(context.req.param('id')),
        );
        return context.json(row);
      },
    );

    return new Hono().route('/', router);
  });
}

/** R-022：报价单七条端点；契约与枚举见 quotation-schemas.ts 与设计页。 */
export const apiRoutes = createQuotationApiRoutes();
