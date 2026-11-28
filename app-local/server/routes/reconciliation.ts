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

import { DocFileRuleError } from '../providers/doc-files.js';
import {
  reasonOf,
  ReconciliationRuleError,
  reconciliationMutationsToken,
  reconciliationReaderToken,
  type CreateDocInput,
  type CreateReconInput,
  type DocKind,
  type ReconciliationRuleCode,
  type ReconKind,
  type UpdateDocInput,
  type UpdateReconInput,
} from '../providers/reconciliation.js';
import {
  CreateIncomeBody, CreatePayableReconBody, CreateReceivableReconBody,
  CreateSaleInvoiceBody, DocListQuery, DocListSchema, DocSchema,
  ReceivableListQuery, ReceivableListSchema,
  ReconListQuery, ReconListSchema, ReconOptionsQuery, ReconOptionsSchema,
  ReconSchema, UpdateIncomeBody, UpdatePayableReconBody,
  UpdateReceivableReconBody, UpdateSaleInvoiceBody,
  PartnerOptionsQuery, PartnerOptionsSchema, SourceDocsQuery, SourceDocsSchema,
} from './reconciliation-schemas.js';

type FinanceContext = Context<AuthEnv & AuthorizationEnv>;
type Decision = AuthorizationDecision<CompositeResourceConditions>;

const CODE_STATUS: Readonly<Record<ReconciliationRuleCode, { status: ApiErrorStatus; httpStatus?: 422 }>> = {
  'finance-not-found': { status: 'NOT_FOUND' },
  'recon-not-found': { status: 'NOT_FOUND' },
  'not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  voided: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'recon-not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'recon-voided': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'recon-not-open': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'bind-mixed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-duplicated': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'recon-empty': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'source-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'customer-mixed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'supplier-mixed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'dict-code-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'partner-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

const camelOf = (code: ReconciliationRuleCode): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

function apiError(error: unknown, translate: Translator, locale: string): never {
  if (error instanceof DocFileRuleError) {
    const status = error.code === 'file-not-found'
      ? 'NOT_FOUND'
      : error.code === 'file-unavailable'
        ? 'FAILED_PRECONDITION'
        : 'INVALID_ARGUMENT';
    throw new ApiError({
      status,
      reason: error.code === 'file-not-found'
        ? 'FILE_NOT_FOUND'
        : error.code === 'file-unavailable'
          ? 'FILE_UNAVAILABLE'
          : 'FILE_TOO_MANY',
      domain: 'reconciliation', message: error.message,
      ...(status === 'FAILED_PRECONDITION' ? { httpStatus: 422 as const } : {}),
      cause: error,
    });
  }
  if (!(error instanceof ReconciliationRuleError)) throw error;
  const rule = CODE_STATUS[error.code];
  throw new ApiError({
    status: rule.status, reason: reasonOf(error.code), domain: 'reconciliation',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`reconciliation.errors.${camelOf(error.code)}`, {
        defaultValue: error.message,
      }),
    },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorize(context: FinanceContext, resource: string, action: string): Promise<Decision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: resource }, action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

/** 先授权后读内容：校验器会解析请求体，必须排在它前面。 */
const authorizeFirst = (resource: string, action: string) =>
  async (context: FinanceContext, next: () => Promise<void>): Promise<void> => {
    await authorize(context, resource, action);
    await next();
  };

function actorOf(context: FinanceContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'reconciliation', message: 'An authenticated user is required.',
    });
  }
  return String(session.user.id);
}

const withErrors = async <T>(context: FinanceContext, work: () => Promise<T>): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    return apiError(error, getRequestTranslator(context), getRequestLocale(context) ?? 'zh-CN');
  }
};

const objectResponse = (schema: Parameters<typeof resolver>[0], description: string) => ({
  description,
  content: { 'application/json': { schema: resolver(schema) } },
});

interface DocBody {
  [key: string]: unknown;
  incomeDate?: string; invoiceDate?: string;
  incomeTypeCode?: string | null; invoiceTypeCode?: string | null;
  fundAccountCode?: string | null;
  payerName?: string | null; invoiceToName?: string | null; invoiceNo?: string | null;
  customerId?: string | null; bindMode?: CreateDocInput['bindMode'];
  handlerUserId?: string | null; projectCode?: string | null; remark?: string;
  fileIds?: string[]; amount?: number; confirm?: boolean;
  lines?: { salesOrderId?: string; receivableReconId?: string; amount: number; note?: string }[];
}
interface ReconBody {
  [key: string]: unknown;
  reconDate?: string; expectedPayDate?: string | null; periodAmount?: number;
  customerId?: string; supplierId?: string; invoiceTypeCode?: string | null;
  contactName?: string | null; phone?: string | null;
  handlerUserId?: string | null; projectCode?: string | null; remark?: string;
  fileIds?: string[];
  outStockDocIds?: string[]; returnDocIds?: string[]; purchaseStockDocIds?: string[];
}
interface Query {
  page: number; pageSize: number;
  kind?: string;
  status?: string; customerId?: string; supplierId?: string; typeCode?: string;
  bindMode?: CreateDocInput['bindMode']; from?: string; to?: string; q?: string;
}

function docInput(kind: DocKind, body: DocBody): CreateDocInput {
  return {
    date: kind === 'income' ? body.incomeDate! : body.invoiceDate!,
    bindMode: body.bindMode!,
    typeCode: kind === 'income' ? body.incomeTypeCode : body.invoiceTypeCode,
    fundAccountCode: body.fundAccountCode,
    payerName: body.payerName, invoiceToName: body.invoiceToName, invoiceNo: body.invoiceNo,
    customerId: body.customerId, handlerUserId: body.handlerUserId,
    projectCode: body.projectCode, remark: body.remark, fileIds: body.fileIds,
    amount: body.amount, confirm: body.confirm,
    lines: body.lines?.map((line) => ({
      salesOrderId: line.salesOrderId, receivableReconId: line.receivableReconId,
      amount: line.amount, note: line.note,
    })),
  };
}

function updateDocInput(kind: DocKind, body: DocBody): UpdateDocInput {
  return {
    date: kind === 'income' ? body.incomeDate : body.invoiceDate,
    bindMode: body.bindMode,
    typeCode: kind === 'income' ? body.incomeTypeCode : body.invoiceTypeCode,
    fundAccountCode: body.fundAccountCode,
    payerName: body.payerName, invoiceToName: body.invoiceToName, invoiceNo: body.invoiceNo,
    customerId: body.customerId, handlerUserId: body.handlerUserId,
    projectCode: body.projectCode, remark: body.remark, fileIds: body.fileIds,
    amount: body.amount,
    lines: body.lines?.map((line) => ({
      salesOrderId: line.salesOrderId, receivableReconId: line.receivableReconId,
      amount: line.amount, note: line.note,
    })),
  };
}

function reconInput(body: ReconBody): CreateReconInput {
  return {
    reconDate: body.reconDate!, periodAmount: body.periodAmount!,
    expectedPayDate: body.expectedPayDate,
    customerId: body.customerId, supplierId: body.supplierId,
    invoiceTypeCode: body.invoiceTypeCode,
    contactName: body.contactName, phone: body.phone,
    handlerUserId: body.handlerUserId, projectCode: body.projectCode,
    remark: body.remark, fileIds: body.fileIds,
    outStockDocIds: body.outStockDocIds, returnDocIds: body.returnDocIds,
    purchaseStockDocIds: body.purchaseStockDocIds,
  };
}

function updateReconInput(body: ReconBody): UpdateReconInput {
  return {
    reconDate: body.reconDate, periodAmount: body.periodAmount,
    expectedPayDate: body.expectedPayDate,
    customerId: body.customerId, supplierId: body.supplierId,
    invoiceTypeCode: body.invoiceTypeCode,
    contactName: body.contactName, phone: body.phone,
    handlerUserId: body.handlerUserId, projectCode: body.projectCode,
    remark: body.remark, fileIds: body.fileIds,
    outStockDocIds: body.outStockDocIds, returnDocIds: body.returnDocIds,
    purchaseStockDocIds: body.purchaseStockDocIds,
  };
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes((app) => {
  const router = new Hono<AuthEnv & AuthorizationEnv>();
  const auth = app.container.resolve(authenticationToken);
  const authz = app.container.resolve(authorizationToken);
  const reader = app.container.resolve(reconciliationReaderToken);
  const mutations = app.container.resolve(reconciliationMutationsToken);

  const protectedPaths = [
    '/income-records', '/income-records/*',
    '/sale-invoice-records', '/sale-invoice-records/*',
    '/receivable-recons', '/receivable-recons/*',
    '/payable-recons', '/payable-recons/*',
    '/sales-orders/receivable',
    '/reconciliation/source-docs', '/reconciliation/partners',
  ];
  for (const base of protectedPaths) router.use(base, auth.required(), authz.middleware());

  // 页面必需的窄读：沿用财务已经拿到的对账单 view 动作，不新增资源、动作或别的角色授权。
  for (const [path, schema, description, resourceOf] of [
    ['/reconciliation/source-docs', SourceDocsQuery, 'List posted stock documents for reconciliation',
      (query: Query) => query.kind === 'out' ? 'receivableRecons' : 'payableRecons'],
    ['/reconciliation/partners', PartnerOptionsQuery, 'List customers or suppliers for reconciliation',
      (query: Query) => query.kind === 'customer' ? 'receivableRecons' : 'payableRecons'],
  ] as const) {
    router.get(
      path,
      describeRoute({
        tags: ['Reconciliation'], summary: description,
        operationId: path.includes('source') ? 'listReconSourceDocs' : 'listReconPartners',
        responses: {
          '200': objectResponse(path.includes('source') ? SourceDocsSchema : PartnerOptionsSchema, description),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', schema),
      async (context) => {
        const query = context.req.valid('query') as Query;
        await authorize(context, resourceOf(query), 'view');
        const result = path.includes('source')
          ? await reader.sourceDocs(query.kind as 'out' | 'in', query)
          : await reader.partnerOptions(query.kind as 'customer' | 'supplier', query);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );
  }

  // 静态段先登记：否则 /:id 会把 options 当成单据编号吞掉。
  for (const [path, kind] of [
    ['/receivable-recons/options', 'receivable'],
    ['/payable-recons/options', 'payable'],
  ] as const) {
    router.get(
      path,
      describeRoute({
        tags: ['Reconciliation'], summary: `List ${kind} reconciliation options`,
        operationId: `list${kind}ReconOptions`,
        responses: {
          '200': objectResponse(ReconOptionsSchema, 'Confirmed statements only'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ReconOptionsQuery),
      async (context) => {
        await authorize(context, kind === 'receivable' ? 'receivableRecons' : 'payableRecons', 'view');
        const query = context.req.valid('query') as Query;
        const result = await reader.reconOptions(kind, query);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );
  }

  router.get(
    '/sales-orders/receivable',
    describeRoute({
      tags: ['Reconciliation'], summary: 'List sales orders for finance reconciliation',
      operationId: 'listReceivableSalesOrders',
      responses: {
        '200': objectResponse(ReceivableListSchema, 'Header and customer summary only'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', ReceivableListQuery),
    async (context) => {
      // 金额列只给 finance：不能用销售的 view 兜底，必须持窄读 financeView。
      await authorize(context, 'salesOrders', 'financeView');
      const query = context.req.valid('query') as Query;
      const result = await reader.receivableOrders(query);
      return context.json({ ...result, page: query.page, pageSize: query.pageSize });
    },
  );

  const docs: readonly {
    kind: DocKind; base: string; resource: string; tag: string; op: string;
    listQuery: z.ZodTypeAny; createBody: z.ZodTypeAny; updateBody: z.ZodTypeAny;
  }[] = [
    {
      kind: 'income', base: '/income-records', resource: 'incomeRecords', tag: 'Income records',
      op: 'Income', listQuery: DocListQuery, createBody: CreateIncomeBody, updateBody: UpdateIncomeBody,
    },
    {
      kind: 'saleInvoice', base: '/sale-invoice-records', resource: 'saleInvoiceRecords',
      tag: 'Sale invoice records', op: 'SaleInvoice',
      listQuery: DocListQuery, createBody: CreateSaleInvoiceBody, updateBody: UpdateSaleInvoiceBody,
    },
  ];

  for (const config of docs) {
    router.get(
      config.base,
      describeRoute({
        tags: [config.tag], summary: `List ${config.tag.toLowerCase()}`,
        operationId: `list${config.op}s`,
        responses: {
          '200': objectResponse(DocListSchema, 'One page of records with empty lines'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
        },
      }),
      authorizeFirst(config.resource, 'view'),
      apiValidator('query', config.listQuery),
      async (context) => {
        const query = context.req.valid('query') as Query;
        const result = await reader.listDocs(config.kind, {
          ...query,
          typeCode: query.typeCode,
        });
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      `${config.base}/:id`,
      describeRoute({
        tags: [config.tag], summary: `Read one ${config.tag.toLowerCase()}`,
        operationId: `read${config.op}`,
        responses: {
          '200': objectResponse(DocSchema, 'The record with lines, customer and files'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorize(context, config.resource, 'view');
        const row = await reader.detailDoc(config.kind, context.req.param('id'));
        if (row === undefined) {
          return apiError(
            new ReconciliationRuleError('finance-not-found'),
            getRequestTranslator(context), getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      config.base,
      describeRoute({
        tags: [config.tag], summary: `Create one ${config.tag.toLowerCase()}`,
        operationId: `create${config.op}`,
        responses: {
          '201': objectResponse(DocSchema, 'The created record'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401),
          '403': apiErrorResponse(403), '422': apiErrorResponse(400), '500': apiErrorResponse(500),
        },
      }),
      authorizeFirst(config.resource, 'create'),
      apiValidator('json', config.createBody),
      async (context) => {
        const row = await withErrors(context, () => mutations.createDoc(
          config.kind, docInput(config.kind, context.req.valid('json') as DocBody), actorOf(context),
        ));
        return context.json(row, 201);
      },
    );

    router.patch(
      `${config.base}/:id`,
      describeRoute({
        tags: [config.tag], summary: `Update a draft ${config.tag.toLowerCase()}`,
        operationId: `update${config.op}`,
        responses: {
          '200': objectResponse(DocSchema, 'The updated record'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '422': apiErrorResponse(400), '500': apiErrorResponse(500),
        },
      }),
      authorizeFirst(config.resource, 'update'),
      apiValidator('json', config.updateBody),
      async (context) => {
        const row = await withErrors(context, () => mutations.updateDoc(
          config.kind, context.req.param('id'),
          updateDocInput(config.kind, context.req.valid('json') as DocBody), actorOf(context),
        ));
        return context.json(row);
      },
    );

    for (const [suffix, action] of [['confirm', 'confirm'], ['void', 'void']] as const) {
      router.post(
        `${config.base}/:id/${suffix}`,
        describeRoute({
          tags: [config.tag], summary: `${action} one ${config.tag.toLowerCase()}`,
          operationId: `${action}${config.op}`,
          responses: {
            '200': objectResponse(DocSchema, 'The record after the state change'),
            '401': apiErrorResponse(401), '403': apiErrorResponse(403),
            '404': apiErrorResponse(404), '422': apiErrorResponse(400), '500': apiErrorResponse(500),
          },
        }),
        async (context) => {
          await authorize(context, config.resource, action);
          const row = await withErrors(context, () => action === 'confirm'
            ? mutations.confirmDoc(config.kind, context.req.param('id'))
            : mutations.voidDoc(config.kind, context.req.param('id')));
          return context.json(row);
        },
      );
    }
  }

  const recons: readonly {
    kind: ReconKind; base: string; resource: string; tag: string; op: string;
    createBody: z.ZodTypeAny; updateBody: z.ZodTypeAny;
  }[] = [
    {
      kind: 'receivable', base: '/receivable-recons', resource: 'receivableRecons',
      tag: 'Receivable reconciliations', op: 'ReceivableRecon',
      createBody: CreateReceivableReconBody, updateBody: UpdateReceivableReconBody,
    },
    {
      kind: 'payable', base: '/payable-recons', resource: 'payableRecons',
      tag: 'Payable reconciliations', op: 'PayableRecon',
      createBody: CreatePayableReconBody, updateBody: UpdatePayableReconBody,
    },
  ];

  for (const config of recons) {
    router.get(
      config.base,
      describeRoute({
        tags: [config.tag], summary: `List ${config.tag.toLowerCase()}`,
        operationId: `list${config.op}s`,
        responses: {
          '200': objectResponse(ReconListSchema, 'One page of statements without snapshot lines'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
        },
      }),
      authorizeFirst(config.resource, 'view'),
      apiValidator('query', ReconListQuery),
      async (context) => {
        const query = context.req.valid('query') as Query;
        const result = await reader.listRecons(config.kind, {
          ...query,
          typeCode: query.typeCode,
        });
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      `${config.base}/:id`,
      describeRoute({
        tags: [config.tag], summary: `Read one ${config.tag.toLowerCase()}`,
        operationId: `read${config.op}`,
        responses: {
          '200': objectResponse(ReconSchema, 'The statement with snapshot lines'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorize(context, config.resource, 'view');
        const row = await reader.detailRecon(config.kind, context.req.param('id'));
        if (row === undefined) {
          return apiError(
            new ReconciliationRuleError('recon-not-found'),
            getRequestTranslator(context), getRequestLocale(context) ?? 'zh-CN',
          );
        }
        return context.json(row);
      },
    );

    router.post(
      config.base,
      describeRoute({
        tags: [config.tag], summary: `Create one ${config.tag.toLowerCase()}`,
        operationId: `create${config.op}`,
        responses: {
          '201': objectResponse(ReconSchema, 'The created statement'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401),
          '403': apiErrorResponse(403), '422': apiErrorResponse(400), '500': apiErrorResponse(500),
        },
      }),
      authorizeFirst(config.resource, 'create'),
      apiValidator('json', config.createBody),
      async (context) => {
        const row = await withErrors(context, () => mutations.createRecon(
          config.kind, reconInput(context.req.valid('json') as ReconBody), actorOf(context),
        ));
        return context.json(row, 201);
      },
    );

    router.patch(
      `${config.base}/:id`,
      describeRoute({
        tags: [config.tag], summary: `Update a draft ${config.tag.toLowerCase()}`,
        operationId: `update${config.op}`,
        responses: {
          '200': objectResponse(ReconSchema, 'The updated statement'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '422': apiErrorResponse(400), '500': apiErrorResponse(500),
        },
      }),
      authorizeFirst(config.resource, 'update'),
      apiValidator('json', config.updateBody),
      async (context) => {
        const row = await withErrors(context, () => mutations.updateRecon(
          config.kind, context.req.param('id'),
          updateReconInput(context.req.valid('json') as ReconBody), actorOf(context),
        ));
        return context.json(row);
      },
    );

    for (const [suffix, action] of [['confirm', 'confirm'], ['void', 'void']] as const) {
      router.post(
        `${config.base}/:id/${suffix}`,
        describeRoute({
          tags: [config.tag], summary: `${action} one ${config.tag.toLowerCase()}`,
          operationId: `${action}${config.op}`,
          responses: {
            '200': objectResponse(ReconSchema, 'The statement after the state change'),
            '401': apiErrorResponse(401), '403': apiErrorResponse(403),
            '404': apiErrorResponse(404), '422': apiErrorResponse(400), '500': apiErrorResponse(500),
          },
        }),
        async (context) => {
          await authorize(context, config.resource, action);
          const row = await withErrors(context, () => action === 'confirm'
            ? mutations.confirmRecon(config.kind, context.req.param('id'))
            : mutations.voidRecon(config.kind, context.req.param('id')));
          return context.json(row);
        },
      );
    }
  }

  return new Hono().route('/', router);
});
