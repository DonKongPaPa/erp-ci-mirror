/**
 * R-078 第一批 23 张报表的定义（代码常量，种子写入 reportDefinitions 表）。
 *
 * 定义不是用户对象：没有建改端点，加第二批时改这里并加一条幂等种子/升级命令。
 * dimensions 是筛选与分组的白名单；measures 是度量白名单；columns 的
 * requiredActions 是「同时持有哪些动作才出现这一列」，`resource.action` 形式。
 * 成本类 9 张、生产类 17 张明确不在这一批 —— 没定义就没有端点，猜 key 得 404。
 */

export type ReportCategory = 'purchase' | 'sales' | 'stock' | 'finance';
export type ReportColumnType = 'text' | 'number' | 'date';

export interface ReportColumn {
  readonly key: string;
  readonly labelKey: string;
  readonly type: ReportColumnType;
  readonly requiredActions?: readonly string[];
}

export interface ReportDefinition {
  readonly id: string;
  readonly key: string;
  readonly titleKey: string;
  readonly category: ReportCategory;
  readonly dimensions: readonly string[];
  readonly measures: readonly string[];
  readonly columns: readonly ReportColumn[];
  readonly baseActions: readonly string[];
  readonly source: string;
  readonly status: 'active' | 'inactive';
}

const PURCHASE_VIEW = 'purchaseOrders.view';
const PURCHASE_PRICE = 'purchaseOrders.viewPrice';
const SALES_VIEW = 'salesOrders.view';
const SALES_LEDGER = 'salesOrders.ledgerView';
const SALES_PRICE = 'salesOrders.viewPrice';
const STOCK_VIEW = 'inventory.stockView';
const STOCK_PRICE = 'inventory.stockPriceView';
const INSPECTION_VIEW = 'inspectionOrders.view';
const QUOTATION_VIEW = 'quotations.view';
const EXPENSE_VIEW = 'expenses.view';
const INCOME_VIEW = 'incomeRecords.view';
const INVOICE_RECEIPT_VIEW = 'invoiceReceipts.view';
const SALE_INVOICE_VIEW = 'saleInvoiceRecords.view';

const STATUS_DIMS = ['receiveStatus', 'payStatus', 'invoiceStatus'] as const;
const SALES_STATUS_DIMS = ['shipStatus', 'payStatus', 'invoiceStatus'] as const;

interface DefInput {
  readonly key: string;
  readonly title: string;
  readonly category: ReportCategory;
  readonly source: string;
  readonly baseActions: readonly string[];
  readonly dimensions: readonly string[];
  readonly measures: readonly string[];
  /** 度量码 → 同时需要的动作；没有声明的列不需要额外动作。 */
  readonly gated?: Readonly<Record<string, readonly string[]>>;
}

function define(input: DefInput): ReportDefinition {
  const columns: ReportColumn[] = [
    ...input.dimensions.map((key) => ({
      key, labelKey: `reporting.columns.${key}`, type: 'text' as const,
    })),
    ...input.measures.map((key) => {
      const requiredActions = input.gated?.[key];
      return {
        key,
        labelKey: `reporting.columns.${key}`,
        type: 'number' as const,
        ...(requiredActions === undefined ? {} : { requiredActions }),
      };
    }),
  ];
  return {
    id: `report-def-${input.key}`.slice(0, 64),
    key: input.key,
    titleKey: `reporting.titles.${input.key}`,
    category: input.category,
    dimensions: [...input.dimensions],
    measures: [...input.measures],
    columns,
    baseActions: [...input.baseActions],
    source: input.source,
    status: 'active',
  };
}

export const REPORT_DEFINITIONS: readonly ReportDefinition[] = [
  define({
    key: 'purchase_detail', title: '采1 采购明细表', category: 'purchase',
    source: 'purchaseOrderLines', baseActions: [PURCHASE_VIEW],
    dimensions: ['date', 'warehouse', 'itemCategory', 'item', 'supplier', 'project'],
    measures: ['qty', 'taxExcludedPrice', 'taxIncludedPrice', 'taxRate', 'taxIncludedAmount'],
    gated: {
      taxExcludedPrice: [PURCHASE_PRICE], taxIncludedPrice: [PURCHASE_PRICE],
      taxRate: [PURCHASE_PRICE], taxIncludedAmount: [PURCHASE_PRICE],
    },
  }),
  define({
    key: 'purchase_tracking', title: '采2 采购订单跟踪汇总表', category: 'purchase',
    source: 'purchaseTracking', baseActions: [PURCHASE_VIEW],
    dimensions: ['date', 'supplier', 'project', ...STATUS_DIMS],
    measures: ['receivedQty', 'returnQty', 'unreceivedQty', 'paidAmount', 'unpaidAmount', 'invoicedAmount', 'uninvoicedAmount'],
    gated: {
      returnQty: ['purchaseReturns.view'],
      paidAmount: [PURCHASE_PRICE], unpaidAmount: [PURCHASE_PRICE],
      invoicedAmount: [PURCHASE_PRICE], uninvoicedAmount: [PURCHASE_PRICE],
    },
  }),
  define({
    key: 'purchase_summary_by_supplier', title: '采4 采购汇总表（按供应商）', category: 'purchase',
    source: 'purchaseOrderLines', baseActions: [PURCHASE_VIEW],
    dimensions: ['date', 'warehouse', 'supplier'],
    measures: ['orderCount', 'purchaseAmount', 'paidAmount', 'unpaidAmount'],
    gated: { purchaseAmount: [PURCHASE_PRICE], paidAmount: [PURCHASE_PRICE], unpaidAmount: [PURCHASE_PRICE] },
  }),
  define({
    key: 'purchase_return_stats', title: '采5 采购及退货统计表', category: 'purchase',
    source: 'purchaseOrderLines', baseActions: [PURCHASE_VIEW],
    dimensions: ['date', 'itemCategory', 'item', 'supplier'],
    measures: ['purchaseQty', 'receivedQty', 'returnQty', 'actualQty', 'pendingQty', 'qualifiedRate', 'amount'],
    gated: { amount: [PURCHASE_PRICE] },
  }),
  define({
    key: 'inspection_records', title: '采8 检验记录明细表', category: 'purchase',
    source: 'inspectionRecords', baseActions: [INSPECTION_VIEW],
    dimensions: ['date', 'purchaseOrderNo', 'item', 'supplier'],
    measures: ['receivedQty', 'inspectionQty', 'qualifiedQty', 'releasableQty', 'returnQty', 'samplingQty'],
  }),
  define({
    key: 'purchase_reconciliation', title: '采9 采购订单对账表', category: 'purchase',
    source: 'purchaseTracking', baseActions: [PURCHASE_VIEW],
    dimensions: ['date', 'supplier', 'project', ...STATUS_DIMS],
    measures: ['preDiscountAmount', 'postDiscountAmount', 'receivedQty', 'receivedAmount', 'unpaidAmount', 'invoicedQty', 'invoicedAmount', 'uninvoicedAmount'],
    gated: {
      preDiscountAmount: [PURCHASE_PRICE], postDiscountAmount: [PURCHASE_PRICE],
      receivedAmount: [PURCHASE_PRICE], unpaidAmount: [PURCHASE_PRICE],
      invoicedAmount: [PURCHASE_PRICE], uninvoicedAmount: [PURCHASE_PRICE],
    },
  }),
  define({
    key: 'sales_detail', title: '销1 销售明细表', category: 'sales',
    source: 'salesOrderLines', baseActions: [SALES_VIEW],
    dimensions: ['date', 'itemCategory', 'item', 'customer', 'salesperson', 'project'],
    measures: ['qty', 'taxIncludedPrice', 'taxRate', 'taxIncludedAmount'],
    gated: {
      taxIncludedPrice: [SALES_PRICE], taxRate: [SALES_PRICE], taxIncludedAmount: [SALES_PRICE],
    },
  }),
  define({
    key: 'sales_tracking', title: '销2 销售订单跟踪汇总表', category: 'sales',
    source: 'salesTracking', baseActions: [SALES_VIEW, SALES_LEDGER],
    dimensions: ['date', 'customer', 'project', 'salesperson', ...SALES_STATUS_DIMS],
    measures: ['shippedQty', 'returnQty', 'unshippedQty', 'receivedAmount', 'unreceivedAmount', 'invoicedAmount', 'uninvoicedAmount'],
    gated: {
      receivedAmount: [SALES_PRICE], unreceivedAmount: [SALES_PRICE],
      invoicedAmount: [SALES_PRICE], uninvoicedAmount: [SALES_PRICE],
    },
  }),
  define({
    key: 'sales_summary_by_customer', title: '销4 销售汇总表（按客户）', category: 'sales',
    source: 'salesOrderLines', baseActions: [SALES_VIEW],
    dimensions: ['date', 'customer', 'salesperson', 'warehouse'],
    measures: ['orderCount', 'amount', 'receivedAmount', 'unreceivedAmount'],
    gated: {
      amount: [SALES_PRICE], receivedAmount: [SALES_PRICE], unreceivedAmount: [SALES_PRICE],
    },
  }),
  define({
    key: 'sales_return_stats', title: '销9 销售及退货统计表', category: 'sales',
    source: 'salesOrderLines', baseActions: [SALES_VIEW],
    dimensions: ['date', 'customer', 'salesperson', 'itemCategory', 'item'],
    measures: ['salesQty', 'shippedQty', 'returnQty', 'actualQty', 'pendingQty', 'amount'],
    gated: { amount: [SALES_PRICE] },
  }),
  define({
    key: 'quotation_detail', title: '销10 报价明细表', category: 'sales',
    source: 'quotations', baseActions: [QUOTATION_VIEW],
    dimensions: ['date', 'customer', 'item', 'salesperson', 'project'],
    measures: ['qty', 'price', 'amount'],
    gated: { price: [SALES_PRICE], amount: [SALES_PRICE] },
  }),
  define({
    key: 'sales_reconciliation', title: '销12 销售订单对账表', category: 'sales',
    source: 'salesTracking', baseActions: [SALES_VIEW],
    dimensions: ['date', 'customer', 'project', ...SALES_STATUS_DIMS],
    measures: ['preDiscountAmount', 'postDiscountAmount', 'shippedQty', 'receivedAmount', 'unreceivedAmount', 'invoicedQty', 'invoicedAmount', 'uninvoicedAmount'],
    gated: {
      preDiscountAmount: [SALES_PRICE], postDiscountAmount: [SALES_PRICE],
      receivedAmount: [SALES_PRICE], unreceivedAmount: [SALES_PRICE],
      invoicedAmount: [SALES_PRICE], uninvoicedAmount: [SALES_PRICE],
    },
  }),
  define({
    key: 'sales_income_expense', title: '销15 销售收支明细表', category: 'sales',
    source: 'financeRecords', baseActions: [INCOME_VIEW, EXPENSE_VIEW],
    dimensions: ['salesOrder'],
    measures: ['preDiscountAmount', 'postDiscountAmount', 'incomeAmount', 'expenseAmount'],
  }),
  define({
    key: 'sales_delivery', title: '销16 销售交付查询表', category: 'sales',
    source: 'salesLedger', baseActions: [SALES_LEDGER],
    dimensions: ['date', 'salesOrder', 'project', 'item', 'deliveryStatus', 'overdue'],
    measures: ['baseQty', 'shippedQty', 'deliveryDays', 'overdueDays'],
  }),
  define({
    key: 'stock_movement_detail', title: '入1 出入库明细表', category: 'stock',
    source: 'stockDocs', baseActions: [STOCK_VIEW],
    dimensions: ['date', 'item', 'partner', 'docType', 'warehouse', 'project'],
    measures: ['inQty', 'outQty', 'taxIncludedPrice', 'taxExcludedAmount', 'preDiscountAmount'],
    gated: {
      taxIncludedPrice: [STOCK_PRICE], taxExcludedAmount: [STOCK_PRICE], preDiscountAmount: [STOCK_PRICE],
    },
  }),
  define({
    key: 'sales_issue_detail', title: '入2 销售出库明细表', category: 'stock',
    source: 'stockDocs', baseActions: [STOCK_VIEW],
    dimensions: ['date', 'itemCategory', 'item', 'customer', 'warehouse', 'salesOrderNo'],
    measures: ['outQty', 'taxIncludedPrice', 'preDiscountAmount'],
    gated: { taxIncludedPrice: [STOCK_PRICE], preDiscountAmount: [STOCK_PRICE] },
  }),
  define({
    key: 'purchase_receipt_detail', title: '入3 采购入库明细表', category: 'stock',
    source: 'stockDocs', baseActions: [STOCK_VIEW],
    dimensions: ['date', 'itemCategory', 'item', 'supplier', 'warehouse', 'purchaseOrderNo'],
    measures: ['inQty', 'taxIncludedPrice', 'preDiscountAmount'],
    gated: { taxIncludedPrice: [STOCK_PRICE], preDiscountAmount: [STOCK_PRICE] },
  }),
  define({
    key: 'stock_summary', title: '入4 出入库汇总表', category: 'stock',
    source: 'stockDocs', baseActions: [STOCK_VIEW],
    dimensions: ['date', 'itemCategory', 'item', 'project', 'warehouse', 'status'],
    measures: ['openingQty', 'closingQty', 'inCount', 'outCount', 'inQty', 'outQty', 'avgPrice', 'amount'],
    gated: { avgPrice: [STOCK_PRICE], amount: [STOCK_PRICE] },
  }),
  define({
    key: 'income_expense_detail', title: '财1 收支明细表', category: 'finance',
    source: 'financeRecords', baseActions: [EXPENSE_VIEW, INCOME_VIEW],
    dimensions: ['date', 'incomeExpenseType', 'customer', 'supplier', 'project', 'handler', 'fundAccount'],
    measures: ['receivedAmount', 'expenseAmount', 'incomeAmountLocal', 'expenseAmountLocal'],
  }),
  define({
    key: 'invoice_receipt_detail', title: '财2 到票记录明细表', category: 'finance',
    source: 'financeRecords', baseActions: [INVOICE_RECEIPT_VIEW],
    dimensions: ['date', 'purchaseOrderNo', 'supplier', 'handler', 'invoiceType', 'invoiceNo', 'project'],
    measures: ['orderTaxIncludedAmount', 'postDiscountAmount', 'receivedInvoiceAmount', 'totalInvoiceAmount'],
  }),
  define({
    key: 'sale_invoice_detail', title: '财3 开票记录明细表', category: 'finance',
    source: 'financeRecords', baseActions: [SALE_INVOICE_VIEW],
    dimensions: ['date', 'salesOrderNo', 'customer', 'handler', 'invoiceType', 'invoiceNo', 'project'],
    measures: ['orderTaxIncludedAmount', 'postDiscountAmount', 'invoiceAmount', 'totalInvoiceAmount'],
  }),
  define({
    key: 'income_record_detail', title: '财4 收入记录明细表', category: 'finance',
    source: 'financeRecords', baseActions: [INCOME_VIEW],
    dimensions: ['date', 'incomeType', 'fundAccount', 'project', 'handler', 'payer', 'salesOrder'],
    measures: ['postDiscountAmount', 'incomeAmount', 'totalIncomeAmount'],
  }),
  define({
    key: 'expense_record_detail', title: '财5 支出记录明细表', category: 'finance',
    source: 'financeRecords', baseActions: [EXPENSE_VIEW],
    dimensions: ['date', 'expenseType', 'fundAccount', 'project', 'handler', 'payee'],
    measures: ['postDiscountAmount', 'expenseAmount', 'totalExpenseAmount'],
  }),
];

export const REPORT_DEFINITION_BY_KEY = new Map(
  REPORT_DEFINITIONS.map((definition) => [definition.key, definition]),
);

/** 成本计价未定，明确拒绝；不要为这些 key 临时编一份定义。 */
export const EXCLUDED_REPORT_KEYS = [
  'inventory_amount_summary', 'gross_margin', 'cost_custom',
  'in5', 'in6', 'in7', 'in8', 'in10', 'in11', 'sale_gross_margin_forecast',
] as const;
