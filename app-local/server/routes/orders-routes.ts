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
import { StockRuleError } from '../providers/inventory.js';
import {
  OrderRuleError,
  orderMutationsToken,
  orderReaderToken,
  type OrderKind,
  type OrderRuleCode,
  type OrderStatus,
} from '../providers/orders.js';
import {
  CreateIssueBody,
  CreatePurchaseOrderBody,
  CreateReceiptBody,
  CreateSalesOrderBody,
  PurchaseOrderListQuery,
  PurchaseOrderListSchema,
  PurchaseOrderSchemaOut,
  ReceivableOrderListSchema,
  SalesOrderListQuery,
  SalesOrderListSchema,
  SalesOrderSchemaOut,
  ShippableOrderListSchema,
  UpdatePurchaseOrderBody,
  UpdateSalesOrderBody,
} from './orders-schemas.js';
import { StockDocSchemaOut } from './inventory-schemas.js';

/** 订单生成的库存单据只会碰到这四类引用校验；其余库存规则码不该在这里出现。 */
type StockReferenceCode =
  | 'warehouse-not-found' | 'warehouse-inactive'
  | 'item-not-found' | 'item-inactive';
type AnyRuleCode = OrderRuleCode | StockReferenceCode;
type OrderAction =
  | 'view' | 'viewPrice' | 'create' | 'update' | 'submit' | 'cancel'
  | 'createReceipt' | 'createIssue' | 'receive' | 'ship';
type OrderContext = Context<AuthEnv & AuthorizationEnv>;
type OrderDecision = AuthorizationDecision<CompositeResourceConditions>;

const RULE_STATUS: Readonly<
  Record<AnyRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'order-not-found': { status: 'NOT_FOUND' },
  'not-draft': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-cancellable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'not-issuable': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-duplicated': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'lines-issued': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'qty-exceeds': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'empty-update': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'partner-not-found': { status: 'NOT_FOUND' },
  'partner-not-supplier': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'partner-not-customer': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'partner-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'item-not-found': { status: 'NOT_FOUND' },
  'item-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'warehouse-not-found': { status: 'NOT_FOUND' },
  'warehouse-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'line-price-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'discount-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'dict-code-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'person-invalid': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
};

/** 规则码逐项写死；订单自己的业务码沿用任务书的大写命名。 */
const RULE_REASON: Readonly<Record<AnyRuleCode, string>> = {
  'order-not-found': 'ORDER_NOT_FOUND',
  'not-draft': 'ORDER_NOT_DRAFT',
  'not-cancellable': 'ORDER_NOT_CANCELLABLE',
  'not-issuable': 'ORDER_NOT_ISSUABLE',
  'line-invalid': 'ORDER_LINE_INVALID',
  'line-duplicated': 'ORDER_LINE_DUPLICATED',
  'lines-issued': 'ORDER_LINES_ALREADY_ISSUED',
  'qty-exceeds': 'ORDER_QTY_EXCEEDS_REMAINING',
  'empty-update': 'ORDER_EMPTY_PATCH',
  'partner-not-found': 'PARTNER_NOT_FOUND',
  'partner-not-supplier': 'PARTNER_NOT_SUPPLIER',
  'partner-not-customer': 'PARTNER_NOT_CUSTOMER',
  'partner-inactive': 'PARTNER_INACTIVE',
  'item-not-found': 'ITEM_NOT_FOUND',
  'item-inactive': 'ITEM_INACTIVE',
  'warehouse-not-found': 'WAREHOUSE_NOT_FOUND',
  'warehouse-inactive': 'WAREHOUSE_INACTIVE',
  'line-price-invalid': 'ORDER_LINE_PRICE_INVALID',
  'discount-invalid': 'ORDER_DISCOUNT_INVALID',
  'dict-code-invalid': 'ORDER_DICT_CODE_INVALID',
  'person-invalid': 'ORDER_PERSON_INVALID',
};

const camelOf = (code: string): string =>
  code.replace(/-([a-z])/gu, (_, letter: string) => letter.toUpperCase());

function orderApiError(
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
  let code: AnyRuleCode;
  let detail: string | undefined;
  if (error instanceof OrderRuleError) {
    code = error.code;
    detail = error.detail;
  } else if (error instanceof StockRuleError) {
    const stockCode = error.code as AnyRuleCode;
    // 只有四类引用校验可能出现在这里；别的库存规则码说明调用链写错了，不要悄悄改头换面。
    if (!(stockCode in RULE_REASON)) throw error;
    code = stockCode;
    detail = error.detail;
  } else {
    throw error;
  }
  const rule = RULE_STATUS[code];
  return new ApiError({
    status: rule.status,
    reason: RULE_REASON[code],
    domain: 'orders',
    message: error.message,
    localizedMessage: {
      locale,
      message: translate(`orders.errors.${camelOf(code)}`, {
        reason: detail ?? '',
        defaultValue: error.message,
      }),
    },
    metadata: detail === undefined ? undefined : { reason: detail },
    ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
    cause: error,
  });
}

async function authorizeOrder(
  context: OrderContext,
  resourceId: string,
  action: OrderAction,
): Promise<OrderDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: resourceId },
    action,
  });
  if (decision.effect === 'deny') throw new AuthorizationDeniedError(decision);
  return decision;
}

async function hasAction(
  context: OrderContext,
  resourceId: string,
  action: OrderAction,
): Promise<boolean> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: resourceId },
    action,
  });
  return decision.effect !== 'deny';
}

function actorOf(context: OrderContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'orders',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

const withMappedErrors = async <T>(
  context: OrderContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw orderApiError(
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

interface ListQuery {
  status?: string;
  q?: string;
  supplierId?: string;
  customerId?: string;
  from?: string;
  to?: string;
  dateField?: 'orderDate';
  projectCode?: string;
  handlerUserId?: string;
  deliveryFrom?: string;
  deliveryTo?: string;
  page: number;
  pageSize: number;
}
interface OrderLineBody {
  itemId: string;
  qty: number;
  price?: number | null;
  taxExcludedPrice?: number | null;
  taxRate?: number | null;
  deliveryDate?: string | null;
  note?: string | null;
}
interface OrderBody {
  supplierId?: string;
  customerId?: string;
  orderDate: string;
  remark?: string;
  warehouseId?: string | null;
  contactName?: string | null;
  contactPhone?: string | null;
  deliveryAddress?: string | null;
  settlementCode?: string | null;
  projectCode?: string | null;
  customerOrderNo?: string | null;
  handlerUserId?: string | null;
  discountAmount?: number;
  fileIds?: string[];
  lines: OrderLineBody[];
}
/** R-021/R-022 的七个端点：先授权、再读内容。没有 DELETE 路由。 */
export function createOrderApiRoutes(
  kind: OrderKind,
): AppApiRouteContribution<Application> {
  const purchase = kind === 'purchase';
  const resourceId = purchase ? 'purchaseOrders' : 'salesOrders';
  const base = purchase ? '/purchase-orders' : '/sales-orders';
  const issueAction: OrderAction = purchase ? 'createReceipt' : 'createIssue';
  const issueSuffix = purchase ? 'create-receipt' : 'create-issue';
  const tag = purchase ? 'Purchase orders' : 'Sales orders';
  const listQuery = purchase ? PurchaseOrderListQuery : SalesOrderListQuery;
  const createBody = purchase ? CreatePurchaseOrderBody : CreateSalesOrderBody;
  const updateBody = purchase ? UpdatePurchaseOrderBody : UpdateSalesOrderBody;
  const issueBody = purchase ? CreateReceiptBody : CreateIssueBody;
  const detailSchema = purchase ? PurchaseOrderSchemaOut : SalesOrderSchemaOut;
  const listSchema = purchase ? PurchaseOrderListSchema : SalesOrderListSchema;
  const narrowListSchema = purchase ? ReceivableOrderListSchema : ShippableOrderListSchema;

  return defineApiRoutes((app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader = app.container.resolve(orderReaderToken);
    const mutations = app.container.resolve(orderMutationsToken);

    for (const route of [base, `${base}/*`]) {
      router.use(route, auth.required(), authz.middleware());
    }

    router.get(
      base,
      describeRoute({
        tags: [tag],
        summary: `List ${kind} orders`,
        operationId: `list${purchase ? 'Purchase' : 'Sales'}Orders`,
        responses: {
          '200': objectResponse(listSchema, 'One page of order summaries'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', listQuery),
      async (context) => {
        await authorizeOrder(context, resourceId, 'view');
        const withPrice = await hasAction(context, resourceId, 'viewPrice');
        const query = context.req.valid('query') as ListQuery;
        const result = await reader.list(kind, {
          ...(query.status === undefined ? {} : { status: query.status as OrderStatus }),
          q: query.q,
          partnerId: purchase ? query.supplierId : query.customerId,
          from: query.from,
          to: query.to,
          dateField: query.dateField,
          projectCode: query.projectCode,
          handlerUserId: query.handlerUserId,
          deliveryFrom: query.deliveryFrom,
          deliveryTo: query.deliveryTo,
          page: query.page,
          pageSize: query.pageSize,
        }, withPrice);
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    // 先于 /:id 注册：否则 "receivable" / "shippable" 会被当成订单 id。
    router.get(
      purchase ? `${base}/receivable` : `${base}/shippable`,
      describeRoute({
        tags: [tag],
        summary: purchase ? 'List receivable purchase orders for the warehouse' : 'List shippable sales orders for the warehouse',
        operationId: purchase ? 'listReceivableOrders' : 'listShippableOrders',
        responses: {
          '200': objectResponse(narrowListSchema, 'One page of narrow order summaries'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', listQuery),
      async (context) => {
        const narrowAction: OrderAction = purchase ? 'receive' : 'ship';
        const decision = await context.get('authz').authorize({
          resource: { type: 'composite', id: resourceId },
          action: narrowAction,
        });
        if (decision.effect === 'deny') await authorizeOrder(context, resourceId, 'view');
        const query = context.req.valid('query') as ListQuery;
        const result = await reader.receivable(kind, {
          q: query.q,
          partnerId: purchase ? query.supplierId : query.customerId,
          page: query.page,
          pageSize: query.pageSize,
        });
        return context.json({ ...result, page: query.page, pageSize: query.pageSize });
      },
    );

    router.get(
      `${base}/:id`,
      describeRoute({
        tags: [tag],
        summary: `Read one ${kind} order with its lines`,
        operationId: `read${purchase ? 'Purchase' : 'Sales'}Order`,
        responses: {
          '200': objectResponse(detailSchema, 'The order with lines and partner summary'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeOrder(context, resourceId, 'view');
        const withPrice = await hasAction(context, resourceId, 'viewPrice');
        const row = await reader.detail(kind, context.req.param('id'), withPrice);
        if (row === undefined) {
          throw orderApiError(
            new OrderRuleError('order-not-found'),
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
        tags: [tag],
        summary: `Create a ${kind} order with lines`,
        description: 'The order number comes from the code service in the same transaction; the order starts as draft.',
        operationId: `create${purchase ? 'Purchase' : 'Sales'}Order`,
        responses: {
          '201': objectResponse(detailSchema, 'The created order'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(detailSchema, 'The request violates an order rule'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', createBody),
      async (context) => {
        await authorizeOrder(context, resourceId, 'create');
        const body = context.req.valid('json') as OrderBody;
        const row = await withMappedErrors(context, async () =>
          mutations.create(kind, {
            partnerId: (purchase ? body.supplierId : body.customerId) ?? '',
            orderDate: body.orderDate,
            remark: body.remark,
            warehouseId: body.warehouseId,
            contactName: body.contactName,
            contactPhone: body.contactPhone,
            deliveryAddress: body.deliveryAddress,
            settlementCode: body.settlementCode,
            projectCode: body.projectCode,
            customerOrderNo: body.customerOrderNo,
            handlerUserId: body.handlerUserId,
            discountAmount: body.discountAmount,
            fileIds: body.fileIds,
            lines: body.lines,
          }, actorOf(context)),
        );
        return context.json(row, 201);
      },
    );

    router.patch(
      `${base}/:id`,
      describeRoute({
        tags: [tag],
        summary: `Replace the lines of a draft ${kind} order`,
        description: 'Drafts only; a supplied line list replaces the whole list. Server-owned columns are ignored.',
        operationId: `update${purchase ? 'Purchase' : 'Sales'}Order`,
        responses: {
          '200': objectResponse(detailSchema, 'The updated order'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(detailSchema, 'The request violates an order rule'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', updateBody),
      async (context) => {
        await authorizeOrder(context, resourceId, 'update');
        const body = context.req.valid('json') as OrderBody;
        const row = await withMappedErrors(context, async () =>
          mutations.update(kind, context.req.param('id'), {
            ...(body.supplierId === undefined && body.customerId === undefined
              ? {}
              : { partnerId: (purchase ? body.supplierId : body.customerId)! }),
            orderDate: body.orderDate,
            remark: body.remark,
            warehouseId: body.warehouseId,
            contactName: body.contactName,
            contactPhone: body.contactPhone,
            deliveryAddress: body.deliveryAddress,
            settlementCode: body.settlementCode,
            projectCode: body.projectCode,
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
      `${base}/:id/submit`,
      describeRoute({
        tags: [tag],
        summary: `Submit a draft ${kind} order`,
        operationId: `submit${purchase ? 'Purchase' : 'Sales'}Order`,
        responses: {
          '200': objectResponse(detailSchema, 'The submitted order'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(detailSchema, 'ORDER_NOT_DRAFT'),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeOrder(context, resourceId, 'submit');
        const row = await withMappedErrors(context, async () =>
          mutations.submit(kind, context.req.param('id')),
        );
        return context.json(row);
      },
    );

    router.post(
      `${base}/:id/cancel`,
      describeRoute({
        tags: [tag],
        summary: `Cancel a ${kind} order`,
        description: 'Drafts and submitted orders with no linked stock document; otherwise ORDER_NOT_CANCELLABLE.',
        operationId: `cancel${purchase ? 'Purchase' : 'Sales'}Order`,
        responses: {
          '200': objectResponse(detailSchema, 'The cancelled order'),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(detailSchema, 'ORDER_NOT_CANCELLABLE'),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeOrder(context, resourceId, 'cancel');
        const row = await withMappedErrors(context, async () =>
          mutations.cancel(kind, context.req.param('id')),
        );
        return context.json(row);
      },
    );

    router.post(
      `${base}/:id/${issueSuffix}`,
      describeRoute({
        tags: [tag],
        summary: purchase ? 'Create an inbound document from the order' : 'Create an outbound document from the order',
        description: 'Creates a draft stock document with the order as source. Omit lines to issue every remaining quantity.',
        operationId: purchase ? 'createPurchaseReceipt' : 'createSalesIssue',
        responses: {
          '201': objectResponse(StockDocSchemaOut, 'The draft stock document'),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '422': objectResponse(StockDocSchemaOut, 'The request violates an order rule'),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', issueBody),
      async (context) => {
        // 仓管用 receive / ship 也能按订单生成草稿；采购/销售用原来的动作。
        const issueDecision = await context.get('authz').authorize({
          resource: { type: 'composite', id: resourceId },
          action: issueAction,
        });
        if (issueDecision.effect === 'deny') {
          await authorizeOrder(context, resourceId, purchase ? 'receive' : 'ship');
        }
        const body = context.req.valid('json');
        const row = await withMappedErrors(context, async () =>
          mutations.issue(kind, context.req.param('id'), body, actorOf(context)),
        );
        return context.json(row, 201);
      },
    );

    return new Hono().route('/', router);
  });
}
