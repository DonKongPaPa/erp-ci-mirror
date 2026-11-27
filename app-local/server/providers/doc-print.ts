import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';
import type { Knex } from 'knex';

/**
 * R-076：打印数据与痕迹。只查库，不授权（授权在路由上先做）；没有 `printPrice` 时
 * 调用方传 withPrice=false，provider 就不查、不回任何价格与金额键。
 *
 * 仓库在 stock_docs 头表上没有列，仓别取明细第一行的 warehouseId —— 与波 0 的表结构一致。
 * 单据日期、往来单位、人员、部门都只回名字与标识，不回邮箱、手机号、部门成员。
 */
export type PrintDocReason = 'internal_use' | 'sales_issue' | 'purchase_receipt';

export class DocPrintRuleError extends Error {
  public constructor(
    readonly code: 'doc-type-invalid' | 'doc-not-found' | 'mark-conflict',
    readonly detail?: string,
  ) {
    super(detail ?? `Document print rule violated: ${code}`);
    this.name = 'DocPrintRuleError';
  }
}

export interface PrintLine {
  seq: number;
  itemCode: string;
  itemName: string;
  spec: string | null;
  unit: string;
  qty: number;
  batchNo: string;
  productionDate: string | null;
  expiryDate: string | null;
  note: string | null;
  taxIncludedPrice?: number | null;
  taxExcludedPrice?: number | null;
  taxRate?: number | null;
  taxAmount?: number | null;
  taxIncludedAmount?: number | null;
  /** 未税金额，打印版式里的 `amount`。 */
  amount?: number | null;
}

export interface PrintData {
  docType: PrintDocReason;
  docNo: string;
  docDate: string | null;
  status: string;
  header: {
    warehouseName: string;
    partnerName: string;
    contactName: string;
    deliveryAddress: string;
    customerOrderNo: string;
    projectName: string;
    handlerName: string;
    takerDepartmentName: string;
    takerName: string;
    remark: string;
  };
  lines: PrintLine[];
  party: { name: string; contactName: string; phone: string };
  totals: {
    totalQty: number | null;
    payableTotal?: number | null;
    taxIncludedTotal?: number | null;
    taxExcludedTotal?: number | null;
    taxTotal?: number | null;
    discountAmount?: number | null;
  };
  amountInWords?: string;
  preparedBy: { id: string; name: string };
  printedAt: string;
  approval: {
    approver: '';
    approvedAt: '';
    approvalStatus: '';
    approvalFlow: '';
  };
  printCount: number;
}

export interface PrintMarkResult {
  docNo: string;
  printCount: number;
  lastPrintedAt: string;
  lastPrintedBy: string;
}

export interface DocPrintService {
  read(docNo: string, reason: PrintDocReason, withPrice: boolean): Promise<PrintData>;
  mark(docNo: string, reason: PrintDocReason, byUserId: string): Promise<PrintMarkResult>;
}

interface DocRow {
  id: string;
  doc_no: string;
  doc_type: string;
  reason: string;
  status: string;
  remark: string;
  doc_date: string | Date | null;
  partner_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  delivery_address: string | null;
  customer_order_no: string | null;
  project_code: string | null;
  handler_user_id: string | null;
  taker_department_id: string | null;
  taker_user_id: string | null;
  created_by_id: string;
  discount_amount: string | number | null;
  total_qty: string | number | null;
  tax_included_total: string | number | null;
  tax_excluded_total: string | number | null;
  tax_total: string | number | null;
  payable_total: string | number | null;
  print_count: string | number;
  last_printed_at: string | Date | null;
  last_printed_by: string | null;
}

interface LineRow {
  id: string;
  doc_id: string;
  item_id: string;
  warehouse_id: string;
  batch_no: string;
  qty: string | number;
  production_date: string | Date | null;
  expiry_date: string | Date | null;
  note: string | null;
  tax_included_price: string | number | null;
  tax_excluded_price: string | number | null;
  tax_rate: string | number | null;
  tax_excluded_amount: string | number | null;
  tax_amount: string | number | null;
  tax_included_amount: string | number | null;
}

interface RefRow { id: string; name: string | null; code?: string | null; }
interface ItemRef extends RefRow { spec: string | null; unitCode: string }

const num = (value: string | number | null | undefined): number | null =>
  value === null || value === undefined ? null : Number(value);
const text = (value: string | null | undefined): string => value ?? '';
const day = (value: string | Date | null | undefined): string | null => {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' ? value.slice(0, 10) : value.toISOString().slice(0, 10);
};

/** Asia/Shanghai 当前时刻，ISO 形状带 +08:00；不依赖进程时区。 */
export function shanghaiNow(): string {
  return new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().replace('Z', '+08:00');
}

const DIGITS = ['零', '壹', '贰', '叁', '肆', '伍', '陆', '柒', '捌', '玖'] as const;
const UNITS = ['', '拾', '佰', '仟'] as const;
const SECTIONS = ['', '万', '亿', '兆'] as const;

function integerInWords(integer: number): string {
  if (integer === 0) return '零';
  const groups: number[] = [];
  let rest = integer;
  while (rest > 0) {
    groups.push(rest % 10000);
    rest = Math.floor(rest / 10000);
  }
  const parts: string[] = [];
  for (let index = groups.length - 1; index >= 0; index -= 1) {
    const group = groups[index] ?? 0;
    const section = SECTIONS[index] ?? '';
    if (group === 0) {
      if (parts.length > 0 && !(parts[parts.length - 1] ?? '').endsWith('零')) parts.push('零');
      continue;
    }
    let piece = '';
    let zero = false;
    for (let digitIndex = 3; digitIndex >= 0; digitIndex -= 1) {
      const digit = Math.floor(group / 10 ** digitIndex) % 10;
      if (digit === 0) {
        zero = true;
      } else {
        if (zero && piece !== '') piece += '零';
        piece += (DIGITS[digit] ?? '') + (UNITS[digitIndex] ?? '');
        zero = false;
      }
    }
    parts.push(piece + section);
  }
  return parts.join('').replace(/零+$/u, '');
}

/** 人民币大写：按 payableTotal（优惠后金额）算，两位小数，角分与「整」按财务口径。 */
export function amountInWords(value: number | null | undefined): string | undefined {
  if (value === null || value === undefined || !Number.isFinite(value)) return undefined;
  const total = Math.round((Number(value.toPrecision(15)) + Number.EPSILON) * 100);
  const yuan = Math.floor(total / 100);
  const jiao = Math.floor((total % 100) / 10);
  const fen = total % 10;
  let textValue = `${integerInWords(yuan)}元`;
  if (jiao === 0 && fen === 0) return `${textValue}整`;
  if (jiao > 0) textValue += `${DIGITS[jiao]}角`;
  else if (fen > 0) textValue += '零';
  if (fen > 0) textValue += `${DIGITS[fen]}分`;
  return textValue;
}

export class DatabaseDocPrintService implements DocPrintService {
  public constructor(private readonly database: DatabaseManager) {}

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }

  public async read(
    docNo: string,
    reason: PrintDocReason,
    withPrice: boolean,
  ): Promise<PrintData> {
    const knex = await this.knex();
    const row = await knex<DocRow>('stock_docs').where({ doc_no: docNo, reason }).first();
    if (row === undefined) throw new DocPrintRuleError('doc-not-found');
    const lines = await knex<LineRow>('stock_doc_lines')
      .where({ doc_id: row.id })
      .orderBy('id', 'asc');
    const itemIds = [...new Set(lines.map((line) => line.item_id))];
    const warehouseIds = [...new Set(lines.map((line) => line.warehouse_id))];
    const userIds = [...new Set(
      [row.handler_user_id, row.taker_user_id, row.created_by_id].filter(
        (id): id is string => id !== null && id !== '',
      ),
    )];
    const refs = await Promise.all([
      itemIds.length === 0
        ? []
        : knex<ItemRef>('items').select('id', 'code', 'name', 'spec', 'unit_code as unitCode').whereIn('id', itemIds),
      warehouseIds.length === 0
        ? []
        : knex<RefRow>('warehouses').select('id', 'name').whereIn('id', warehouseIds),
      userIds.length === 0
        ? []
        : knex<RefRow>('user').select('id', 'name').whereIn('id', userIds),
      row.taker_department_id === null
        ? []
        : knex<{ id: string; title: string }>('departments')
            .select('id', 'title')
            .where('id', row.taker_department_id),
      row.partner_id === null
        ? []
        : knex<RefRow>('partners').select('id', 'name').where('id', row.partner_id),
      row.project_code === null
        ? []
        : knex<RefRow & { dict_type: string }>('biz_dict_entries')
            .select('id', 'name')
            .where({ dict_type: 'project', code: row.project_code }),
    ]);
    const items = refs[0] as ItemRef[];
    const warehouses = refs[1] as RefRow[];
    const users = refs[2] as RefRow[];
    const departments = refs[3] as { id: string; title: string }[];
    const partners = refs[4] as RefRow[];
    const projects = refs[5] as RefRow[];
    const itemsById = new Map(items.map((item) => [item.id, item]));
    const warehousesById = new Map(warehouses.map((warehouse) => [warehouse.id, warehouse]));
    const usersById = new Map(users.map((user) => [user.id, user]));
    const userName = (id: string | null): string =>
      id === null ? '' : usersById.get(id)?.name ?? id;
    const partnerName = partners[0]?.name ?? '';

    const printedLines: PrintLine[] = lines.map((line, index) => {
      const item = itemsById.get(line.item_id);
      const base: PrintLine = {
        seq: index + 1,
        itemCode: item?.code ?? line.item_id,
        itemName: item?.name ?? line.item_id,
        spec: item?.spec ?? null,
        unit: item?.unitCode ?? '',
        qty: Number(line.qty),
        batchNo: text(line.batch_no),
        productionDate: day(line.production_date),
        expiryDate: day(line.expiry_date),
        note: line.note ?? null,
      };
      return withPrice
        ? {
            ...base,
            taxIncludedPrice: num(line.tax_included_price),
            taxExcludedPrice: num(line.tax_excluded_price),
            taxRate: num(line.tax_rate),
            taxAmount: num(line.tax_amount),
            taxIncludedAmount: num(line.tax_included_amount),
            amount: num(line.tax_excluded_amount),
          }
        : base;
    });

    const totals: PrintData['totals'] = { totalQty: num(row.total_qty) };
    if (withPrice) {
      totals.discountAmount = num(row.discount_amount);
      totals.taxIncludedTotal = num(row.tax_included_total);
      totals.taxExcludedTotal = num(row.tax_excluded_total);
      totals.taxTotal = num(row.tax_total);
      totals.payableTotal = num(row.payable_total);
    }

    return {
      docType: reason,
      docNo: row.doc_no,
      docDate: day(row.doc_date),
      status: row.status,
      header: {
        warehouseName: warehousesById.get(lines[0]?.warehouse_id ?? '')?.name ?? '',
        partnerName,
        contactName: text(row.contact_name),
        deliveryAddress: text(row.delivery_address),
        customerOrderNo: text(row.customer_order_no),
        projectName: projects[0]?.name ?? text(row.project_code),
        handlerName: userName(row.handler_user_id),
        takerDepartmentName: departments[0]?.title ?? '',
        takerName: userName(row.taker_user_id),
        remark: text(row.remark),
      },
      lines: printedLines,
      party: {
        name: partnerName,
        contactName: text(row.contact_name),
        phone: text(row.contact_phone),
      },
      totals,
      ...(withPrice
        ? { amountInWords: amountInWords(num(row.payable_total)) }
        : {}),
      preparedBy: { id: row.created_by_id, name: userName(row.created_by_id) },
      printedAt: shanghaiNow(),
      approval: {
        approver: '',
        approvedAt: '',
        approvalStatus: '',
        approvalFlow: '',
      },
      printCount: Number(row.print_count ?? 0),
    };
  }

  public async mark(
    docNo: string,
    reason: PrintDocReason,
    byUserId: string,
  ): Promise<PrintMarkResult> {
    try {
      return await this.database.transaction(async (tx) => {
        const knex = await tx.client<Knex>();
        // 行锁把同一单据的并发 print-mark 串行；后一个读到前一个已提交的新计数。
        const row = await knex<DocRow>('stock_docs')
          .where({ doc_no: docNo, reason })
          .forUpdate()
          .first();
        if (row === undefined) throw new DocPrintRuleError('doc-not-found');
        const printCount = Number(row.print_count ?? 0) + 1;
        const lastPrintedAt = shanghaiNow();
        await knex('stock_docs')
          .where({ id: row.id })
          .update({ print_count: printCount, last_printed_at: lastPrintedAt, last_printed_by: byUserId });
        return { docNo, printCount, lastPrintedAt, lastPrintedBy: byUserId };
      });
    } catch (error) {
      if (error instanceof DocPrintRuleError) throw error;
      throw new DocPrintRuleError('mark-conflict', error instanceof Error ? error.message : undefined);
    }
  }
}

export const docPrintToken: ServiceToken<DocPrintService> =
  createServiceToken<DocPrintService>('app/doc-print');

export default class DocPrintProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.doc-print';

  public override register(): void {
    this.app.container.singleton(docPrintToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseDocPrintService(database);
    });
  }
}
