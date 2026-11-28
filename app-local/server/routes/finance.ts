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
  FinanceRuleError,
  financeMutationsToken,
  financeReaderToken,
  type CreateFinanceInput,
  type FinanceKind,
  type FinanceRuleCode,
  type UpdateFinanceInput,
} from '../providers/finance.js';
import {
  CreateExpenseBody, CreateInvoiceReceiptBody, ExpenseListQuery, ExpenseListSchema,
  ExpenseSchema, InvoiceReceiptListQuery, InvoiceReceiptListSchema, InvoiceReceiptSchema,
  PayableListQuery, PayableListSchema, SupplierOptionsQuery, SupplierOptionsSchema,
  UpdateExpenseBody, UpdateInvoiceReceiptBody,
} from './finance-schemas.js';

type FinanceContext = Context<AuthEnv & AuthorizationEnv>;
type Decision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<Record<FinanceRuleCode, { status: ApiErrorStatus; httpStatus?: 422 }>> = {
  'finance-not-found': { status: 'NOT_FOUND' },
  'not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  voided: { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'order-not-payable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'supplier-mixed': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'dict-code-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'partner-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};
const RULE_REASON: Readonly<Record<FinanceRuleCode, string>> = {
  'finance-not-found': 'FINANCE_NOT_FOUND',
  'not-draft': 'FINANCE_NOT_DRAFT',
  voided: 'FINANCE_VOIDED',
  'line-invalid': 'FINANCE_LINE_INVALID',
  'order-not-payable': 'FINANCE_ORDER_NOT_PAYABLE',
  'supplier-mixed': 'FINANCE_SUPPLIER_MIXED',
  'dict-code-invalid': 'FINANCE_DICT_CODE_INVALID',
  'person-invalid': 'FINANCE_PERSON_INVALID',
  'partner-invalid': 'FINANCE_PARTNER_INVALID',
};

const camelOf = (code: FinanceRuleCode): string =>
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
      domain: 'finance', message: error.message,
      ...(status === 'FAILED_PRECONDITION' ? { httpStatus: 422 as const } : {}),
      cause: error,
    });
  }
  if (!(error instanceof FinanceRuleError)) throw error;
  const rule = RULE_STATUS[error.code];
  throw new ApiError({
    status: rule.status, reason: RULE_REASON[error.code], domain: 'finance',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`finance.errors.${camelOf(error.code)}`, {
        defaultValue: error.message,
      }),
    },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorize(
  context: FinanceContext,
  resource: string,
  action: string,
): Promise<Decision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: resource }, action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

async function may(context: FinanceContext, resource: string, action: string): Promise<boolean> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: resource }, action,
  });
  return decision.effect !== 'deny';
}

function actorOf(context: FinanceContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED', reason: 'AUTHENTICATION_REQUIRED',
      domain: 'finance', message: 'An authenticated user is required.',
    });
  }
  return String(session.user.id);
}

const withErrors = async <T>(
  context: FinanceContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    return apiError(
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

interface Body {
  [key: string]: unknown;
  expenseDate?: string; invoiceDate?: string; date?: string;
  expenseTypeCode?: string | null; fundAccountCode?: string | null;
  invoiceTypeCode?: string | null; issuerName?: string | null; invoiceNo?: string | null;
  payeeName?: string | null; payeeAccountNo?: string | null;
  payeeBankName?: string | null; payeeBankCode?: string | null;
  supplierId?: string | null; bindMode?: 'purchase_order' | 'none';
  handlerUserId?: string | null; projectCode?: string | null; remark?: string;
  fileIds?: string[]; amount?: number;
  confirm?: boolean;
  lines?: { purchaseOrderId: string; amount: number; note?: string }[];
}
interface Query {
  status?: 'draft' | 'confirmed' | 'void'; supplierId?: string; expenseTypeCode?: string; fundAccountCode?: string;
  invoiceTypeCode?: string; invoiceNo?: string; projectCode?: string;
  from?: string; to?: string; q?: string; page: number; pageSize: number;
}

function createInput(kind: FinanceKind, body: Body): CreateFinanceInput {
  return {
    date: kind === 'expense' ? body.expenseDate! : body.invoiceDate!,
    bindMode: body.bindMode!,
    typeCode: kind === 'expense' ? body.expenseTypeCode : body.invoiceTypeCode,
    fundAccountCode: body.fundAccountCode,
    issuerName: body.issuerName, invoiceNo: body.invoiceNo,
    payeeName: body.payeeName,
    payeeAccountNo: body.payeeAccountNo,
    payeeBankName: body.payeeBankName,
    payeeBankCode: body.payeeBankCode,
    supplierId: body.supplierId, handlerUserId: body.handlerUserId,
    projectCode: body.projectCode, remark: body.remark, fileIds: body.fileIds,
    amount: body.amount, lines: body.lines, confirm: body.confirm,
  };
}

function updateInput(kind: FinanceKind, body: Body): UpdateFinanceInput {
  return {
    date: kind === 'expense' ? body.expenseDate : body.invoiceDate,
    typeCode: kind === 'expense' ? body.expenseTypeCode : body.invoiceTypeCode,
    fundAccountCode: body.fundAccountCode,
    issuerName: body.issuerName, invoiceNo: body.invoiceNo,
    payeeName: body.payeeName,
    payeeAccountNo: body.payeeAccountNo,
    payeeBankName: body.payeeBankName,
    payeeBankCode: body.payeeBankCode,
    supplierId: body.supplierId, handlerUserId: body.handlerUserId,
    projectCode: body.projectCode, remark: body.remark, fileIds: body.fileIds,
    amount: body.amount, lines: body.lines,
  };
}

export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes((app) => {
  const router = new Hono<AuthEnv & AuthorizationEnv>();
  const auth = app.container.resolve(authenticationToken);
  const authz = app.container.resolve(authorizationToken);
  const reader = app.container.resolve(financeReaderToken);
  const mutations = app.container.resolve(financeMutationsToken);

  for (const base of [
    '/expenses', '/expenses/*', '/invoice-receipts', '/invoice-receipts/*',
    '/purchase-orders/payable',
  ]) {
    router.use(base, auth.required(), authz.middleware());
  }

  const kinds: readonly {
    kind: FinanceKind; base: string; resource: string; tag: string;
    listQuery: z.ZodTypeAny; createBody: z.ZodTypeAny;
    updateBody: z.ZodTypeAny; schema: Parameters<typeof resolver>[0];
    listSchema: Parameters<typeof resolver>[0]; op: string;
  }[] = [
    {
      kind: 'expense', base: '/expenses', resource: 'expenses', tag: 'Expenses',
      listQuery: ExpenseListQuery, createBody: CreateExpenseBody,
      updateBody: UpdateExpenseBody, schema: ExpenseSchema,
      listSchema: ExpenseListSchema, op: 'Expense',
    },
    {
      kind: 'invoiceReceipt', base: '/invoice-receipts', resource: 'invoiceReceipts',
      tag: 'Invoice receipts', listQuery: InvoiceReceiptListQuery,
      createBody: CreateInvoiceReceiptBody, updateBody: UpdateInvoiceReceiptBody,
      schema: InvoiceReceiptSchema, listSchema: InvoiceReceiptListSchema, op: 'InvoiceReceipt',
    },
  ];

  // 静态路径必须先登记：否则 /expenses/:id 会把 supplier-options 当成单据编号吞掉。
  router.get(
    '/expenses/supplier-options',
    describeRoute({
      tags: ['Finance'], summary: 'List active suppliers for finance',
      operationId: 'listFinanceSupplierOptions',
      responses: {
        '200': objectResponse(SupplierOptionsSchema, 'One page of suppliers'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', SupplierOptionsQuery),
    async (context) => {
      if (!(await may(context, 'expenses', 'view'))) {
        await authorize(context, 'invoiceReceipts', 'view');
      }
      const query = context.req.valid('query') as Query;
      const result = await reader.supplierOptions(query);
      return context.json({ ...result, page: query.page, pageSize: query.pageSize });
    },
  );

  for (const config of kinds) {
    router.get(
      config.base,
      describeRoute({
        tags: [config.tag], summary: `List ${config.tag.toLowerCase()}`,
        operationId: `list${config.op}s`,
        responses: {
          '200': objectResponse(config.listSchema, 'One page of records without lines'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', config.listQuery),
      async (context) => {
        await authorize(context, config.resource, 'view');
        const query = context.req.valid('query') as Query;
        const result = await reader.list(config.kind, {
          ...query,
          status: query.status,
          typeCode: config.kind === 'expense' ? query.expenseTypeCode : query.invoiceTypeCode,
          invoiceNo: query.invoiceNo,
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
          '200': objectResponse(config.schema, 'The record with lines, supplier and files'),
          '401': apiErrorResponse(401), '403': apiErrorResponse(403),
          '404': apiErrorResponse(404), '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorize(context, config.resource, 'view');
        const row = await reader.detail(config.kind, context.req.param('id'));
        if (row === undefined) {
          return apiError(
            new FinanceRuleError('finance-not-found'),
            getRequestTranslator(context),
            getRequestLocale(context) ?? 'zh-CN',
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
          '201': objectResponse(config.schema, 'The created record'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401),
          '403': apiErrorResponse(403), '422': apiErrorResponse(400),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', config.createBody),
      async (context) => {
        await authorize(context, config.resource, 'create');
        const body = context.req.valid('json') as Body;
        const row = await withErrors(context, () => mutations.create(
          config.kind, createInput(config.kind, body), actorOf(context),
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
          '200': objectResponse(config.schema, 'The updated record'),
          '400': apiErrorResponse(400), '401': apiErrorResponse(401),
          '403': apiErrorResponse(403), '404': apiErrorResponse(404),
          '422': apiErrorResponse(400), '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', config.updateBody),
      async (context) => {
        await authorize(context, config.resource, 'update');
        const body = context.req.valid('json') as Body;
        const row = await withErrors(context, () => mutations.update(
          config.kind, context.req.param('id'), updateInput(config.kind, body), actorOf(context),
        ));
        return context.json(row);
      },
    );

    for (const [suffix, action, op] of [
      ['confirm', 'confirm', 'Confirm'], ['void', 'void', 'Void'],
    ] as const) {
      router.post(
        `${config.base}/:id/${suffix}`,
        describeRoute({
          tags: [config.tag], summary: `${op} one ${config.tag.toLowerCase()}`,
          operationId: `${op.toLowerCase()}${config.op}`,
          responses: {
            '200': objectResponse(config.schema, 'The record after the state change'),
            '401': apiErrorResponse(401), '403': apiErrorResponse(403),
            '404': apiErrorResponse(404), '422': apiErrorResponse(400),
            '500': apiErrorResponse(500),
          },
        }),
        async (context) => {
          await authorize(context, config.resource, action);
          const row = await withErrors(context, () => mutations[action](
            config.kind, context.req.param('id'), actorOf(context),
          ));
          return context.json(row);
        },
      );
    }
  }

  /** 财务选采购订单：只有头上的金额与对方的收款信息，没有明细、价格、备注、经办人。 */
  router.get(
    '/purchase-orders/payable',
    describeRoute({
      tags: ['Finance'], summary: 'List payable purchase orders for finance',
      operationId: 'listPayablePurchaseOrders',
      responses: {
        '200': objectResponse(PayableListSchema, 'One page of payable orders'),
        '401': apiErrorResponse(401), '403': apiErrorResponse(403), '500': apiErrorResponse(500),
      },
    }),
    apiValidator('query', PayableListQuery),
    async (context) => {
      if (!(await may(context, 'purchaseOrders', 'financeView'))) {
        await authorize(context, 'purchaseOrders', 'view');
      }
      const query = context.req.valid('query') as Query;
      const result = await reader.payable(query);
      return context.json({ ...result, page: query.page, pageSize: query.pageSize });
    },
  );

  return new Hono().route('/', router);
});
