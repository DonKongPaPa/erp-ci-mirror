import type { Application } from '@nocobase/app-server/application';
import { loggingToken } from '@nocobase/app-server/logging';
import {
  databaseManagerToken,
  type DatabaseConnection,
  type DatabaseManager,
} from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

import {
  assertActiveCodes,
  assertApplicableFields,
  assertDictType,
  assertEntryValues,
  bizDictReaderToken,
  type BizDictType,
  BizDictRuleError,
  type DatabaseBizDictReader,
} from './biz-dict.js';
import {
  itemsMutationsToken,
  type ItemsMutations,
} from './items.js';
import {
  partnerMutationsToken,
  type PartnerMutations,
} from './partners.js';
import {
  stockMutationsToken,
  type StockMutations,
} from './inventory.js';

/**
 * R-068 工具加片：UTF-8 CSV 上传、进程内令牌、试运行与整批事务导入。
 *
 * 只收 CSV、只写已有表、只给 root（授权在路由层、读文件之前）。令牌 30 分钟过期、
 * 不落盘；commit 只能用一次。所有行级校验在试运行与确认导入之间共用同一份解析结果，
 * 写入全部复用 ItemsMutations / PartnerMutations / StockMutations / bizDict 写服务，
 * 并接受可选的事务参数，使整批落在同一个数据库事务里。
 */
export const IMPORT_KINDS = [
  'items',
  'partners',
  'warehouses',
  'bizDict',
  'openingStock',
] as const;
export type ImportKind = (typeof IMPORT_KINDS)[number];

export type ImportIssueCode =
  | 'IMPORT_UNIT_NOT_FOUND'
  | 'IMPORT_CATEGORY_NOT_FOUND'
  | 'IMPORT_GROUP_NOT_FOUND'
  | 'IMPORT_DICT_TYPE_INVALID'
  | 'IMPORT_REQUIRED_EMPTY'
  | 'IMPORT_VALUE_INVALID'
  | 'IMPORT_OPENING_EXISTS'
  | 'IMPORT_EXTRA_COLUMN'
  | 'IMPORT_ZERO_QTY_SKIPPED';

export interface ImportIssue {
  readonly row: number;
  readonly code: ImportIssueCode;
  readonly message: string;
}
export interface ImportReport {
  readonly kind: ImportKind;
  readonly rowCount: number;
  readonly wouldCreate: number;
  readonly wouldSkip: number;
  readonly wouldUpdate: number;
  readonly errorCount: number;
  readonly issues: readonly ImportIssue[];
}
/** 只有这些码挡住整批；提示类的码（多余列、跳过零行）不挡。 */
const BLOCKING = new Set<ImportIssueCode>([
  'IMPORT_UNIT_NOT_FOUND',
  'IMPORT_CATEGORY_NOT_FOUND',
  'IMPORT_GROUP_NOT_FOUND',
  'IMPORT_DICT_TYPE_INVALID',
  'IMPORT_REQUIRED_EMPTY',
  'IMPORT_VALUE_INVALID',
  'IMPORT_OPENING_EXISTS',
]);
const MESSAGE: Readonly<Record<ImportIssueCode, string>> = {
  IMPORT_UNIT_NOT_FOUND: '计量单位不存在',
  IMPORT_CATEGORY_NOT_FOUND: '物料分类不存在',
  IMPORT_GROUP_NOT_FOUND: '分组字典不存在或未在用',
  IMPORT_DICT_TYPE_INVALID: '字典类型不在规定的九类里',
  IMPORT_REQUIRED_EMPTY: '必填列为空',
  IMPORT_VALUE_INVALID: '取值不符合约束',
  IMPORT_OPENING_EXISTS: '期初余额已存在',
  IMPORT_EXTRA_COLUMN: '多余的列已忽略',
  IMPORT_ZERO_QTY_SKIPPED: '数量为零的行已跳过',
};

export type ImportRuleCode =
  | 'IMPORT_KIND_INVALID'
  | 'IMPORT_ENCODING_INVALID'
  | 'IMPORT_HEADER_INVALID'
  | 'IMPORT_DUPLICATE_KEY'
  | 'IMPORT_TOKEN_INVALID'
  | 'IMPORT_NOT_DRY_RUN'
  | 'IMPORT_VALIDATION_FAILED'
  | 'IMPORT_COMMIT_FAILED'
  | 'OPENING_ALREADY_IMPORTED'
  | 'NO_PERMISSION';

export class ImportRuleError extends Error {
  public constructor(
    readonly code: ImportRuleCode | ImportIssueCode,
    readonly issues: readonly ImportIssue[] = [],
  ) {
    super(`Import rule violated: ${code}`);
    this.name = 'ImportRuleError';
  }
}

interface KindSpec {
  readonly headers: readonly string[];
  readonly required: readonly string[];
  /** 文件内判重的业务键；返回空串表示没有键，不参与判重。 */
  readonly key: (row: Row) => string;
}
type Row = Readonly<Record<string, string>>;

const SPECS: Readonly<Record<ImportKind, KindSpec>> = {
  items: {
    headers: [
      'code', 'legacyCode', 'name', 'spec', 'unitCode', 'categoryCode',
      'category2Code', 'category3Code', 'purchasePrice', 'salesPrice',
      'stockMin', 'stockMax', 'barcode', 'brand', 'manufacturerModel',
      'leadTimeDays', 'note',
    ],
    required: ['name', 'unitCode'],
    key: (row) => row.code || row.legacyCode || '',
  },
  partners: {
    headers: [
      'code', 'legacyCode', 'partnerType', 'name', 'groupCode',
      'contactName', 'contactPhone', 'contactEmail', 'note',
    ],
    required: ['partnerType', 'name'],
    key: (row) => row.code || row.legacyCode || '',
  },
  warehouses: {
    headers: ['code', 'name', 'status', 'note'],
    required: ['code', 'name'],
    key: (row) => row.code,
  },
  bizDict: {
    headers: ['dictType', 'code', 'name', 'rate', 'sort', 'status'],
    required: ['dictType', 'code', 'name'],
    key: (row) => `${row.dictType}:${row.code}`,
  },
  openingStock: {
    headers: [
      'warehouseCode', 'itemCode', 'qty', 'batchNo', 'productionDate', 'expiryDate', 'note',
    ],
    required: ['warehouseCode', 'itemCode', 'qty'],
    key: (row) => `${row.warehouseCode}:${row.itemCode}:${row.batchNo}`,
  },
};

export function isImportKind(value: string): value is ImportKind {
  return (IMPORT_KINDS as readonly string[]).includes(value);
}

interface ImportSession {
  readonly kind: ImportKind;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly createdAt: number;
  dryRunAt?: number;
}
const TOKEN_TTL_MS = 30 * 60 * 1000;

interface ImportLogger {
  info(bindings: Record<string, unknown>, message: string): void;
}

export interface ImportToolService {
  parse(
    kind: ImportKind,
    bytes: Uint8Array,
    contentType: string | undefined,
  ): Promise<{ token: string; rowCount: number; headers: readonly string[]; issues: readonly ImportIssue[] }>;
  dryRun(kind: ImportKind, token: string): Promise<ImportReport>;
  commit(
    kind: ImportKind,
    token: string,
    mode: 'skip' | 'update',
    actorId: string,
  ): Promise<ImportReport>;
}

/** 手写的 RFC4180 子集：引号包住逗号、双引号转义、CRLF/LF 都吃；不引第三方依赖。 */
function parseCsv(text: string): { headers: string[]; rows: string[][] } {
  const normalized = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  const records: string[][] = [];
  let field = '';
  let record: string[] = [];
  let quoted = false;
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (quoted) {
      if (char === '"' && normalized[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field.length > 0 || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  const [headers = [], ...rows] = records;
  return { headers, rows };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/u, '');
}

/** content-type 声明了非 UTF-8 字符集时直接拒收，不猜编码、不转码。 */
function assertUtf8(contentType: string | undefined, bytes: Uint8Array): string {
  const declared = /charset\s*=\s*"?([a-z0-9_-]+)"?/iu.exec(contentType ?? '')?.[1];
  if (declared !== undefined && !['utf-8', 'utf8'].includes(declared.toLowerCase())) {
    throw new ImportRuleError('IMPORT_ENCODING_INVALID');
  }
  try {
    return decodeUtf8(bytes);
  } catch {
    throw new ImportRuleError('IMPORT_ENCODING_INVALID');
  }
}

const rowOf = (headers: readonly string[], cells: readonly string[]): Row =>
  Object.fromEntries(headers.map((header, index) => [header, (cells[index] ?? '').trim()]));

const issue = (
  row: number,
  code: ImportIssueCode,
  detail?: string,
): ImportIssue => ({ row, code, message: MESSAGE[code] + (detail ? `: ${detail}` : '') });

type Action = (tx: DatabaseConnection, mode: 'skip' | 'update', actorId: string) => Promise<void>;

interface Plan {
  readonly report: ImportReport;
  actions: Action[];
  batchActions: Action[];
}

export class DatabaseImportToolService implements ImportToolService {
  private readonly sessions = new Map<string, ImportSession>();

  public constructor(
    private readonly database: DatabaseManager,
    private readonly itemsMutations: ItemsMutations,
    private readonly partnerMutations: PartnerMutations,
    private readonly stockMutations: StockMutations,
    private readonly dicts: DatabaseBizDictReader,
    private readonly logger: ImportLogger,
  ) {}

  public async parse(
    kind: ImportKind,
    bytes: Uint8Array,
    contentType: string | undefined,
  ): Promise<{
    token: string;
    rowCount: number;
    headers: readonly string[];
    issues: readonly ImportIssue[];
  }> {
    const started = Date.now();
    const text = assertUtf8(contentType, bytes);
    const { headers, rows } = parseCsv(text);
    const spec = SPECS[kind];
    const missing = spec.required.filter((name) => !headers.includes(name));
    if (missing.length > 0) throw new ImportRuleError('IMPORT_HEADER_INVALID');
    const objects = rows.map((cells) => rowOf(headers, cells));
    const seen = new Set<string>();
    for (const row of objects) {
      const key = spec.key(row);
      if (key !== '' && seen.has(key)) throw new ImportRuleError('IMPORT_DUPLICATE_KEY');
      if (key !== '') seen.add(key);
    }
    const extra = headers
      .filter((name) => !spec.headers.includes(name))
      .map((name) => issue(1, 'IMPORT_EXTRA_COLUMN', name));
    const token = randomUUID();
    this.sessions.set(token, { kind, headers, rows, createdAt: Date.now() });
    this.log('parse', kind, rows.length, extra.map((entry) => entry.code), Date.now() - started);
    return { token, rowCount: rows.length, headers, issues: extra };
  }

  private session(kind: ImportKind, token: string): ImportSession {
    const found = this.sessions.get(token);
    if (found === undefined || found.kind !== kind || Date.now() - found.createdAt > TOKEN_TTL_MS) {
      if (found !== undefined) this.sessions.delete(token);
      throw new ImportRuleError('IMPORT_TOKEN_INVALID');
    }
    return found;
  }

  public async dryRun(kind: ImportKind, token: string): Promise<ImportReport> {
    const started = Date.now();
    const found = this.session(kind, token);
    // 先记账再校验：试运行即使回 422（如期初已导过）也算跑过，commit 才回同一条 422。
    found.dryRunAt = Date.now();
    const plan = await this.plan(kind, found, 'skip');
    this.log(
      'dry-run', kind, plan.report.rowCount,
      plan.report.issues.map((entry) => entry.code), Date.now() - started,
    );
    return plan.report;
  }

  public async commit(
    kind: ImportKind,
    token: string,
    mode: 'skip' | 'update',
    actorId: string,
  ): Promise<ImportReport> {
    const started = Date.now();
    const found = this.session(kind, token);
    if (found.dryRunAt === undefined) throw new ImportRuleError('IMPORT_NOT_DRY_RUN');
    try {
      const plan = await this.plan(kind, found, mode);
      if (plan.report.errorCount > 0) {
        throw new ImportRuleError('IMPORT_VALIDATION_FAILED', plan.report.issues);
      }
      await this.database.transaction(async (tx) => {
        for (const action of plan.actions) await action(tx, mode, actorId);
        for (const action of plan.batchActions) await action(tx, mode, actorId);
      });
      this.sessions.delete(token);
      this.log(
        'commit', kind, plan.report.rowCount,
        plan.report.issues.map((entry) => entry.code), Date.now() - started,
      );
      return plan.report;
    } catch (error) {
      this.log(
        'commit-failed', kind, found.rows.length,
        error instanceof ImportRuleError ? error.issues.map((entry) => entry.code) : ['IMPORT_COMMIT_FAILED'],
        Date.now() - started,
      );
      if (error instanceof ImportRuleError) throw error;
      throw new ImportRuleError('IMPORT_COMMIT_FAILED');
    }
  }

  private log(
    event: string,
    kind: ImportKind,
    rowCount: number,
    codes: readonly string[],
    durationMs: number,
  ): void {
    // 只记类型、行数、错误码与耗时；任何原始单元格（姓名、电话、邮箱、公司名）都不进来。
    this.logger.info(
      { event, kind, rowCount, codes: [...new Set(codes)], durationMs },
      'import tool',
    );
  }

  private async plan(kind: ImportKind, session: ImportSession, mode: 'skip' | 'update'): Promise<Plan> {
    const knex = await this.database.connection().client<Knex>();
    const issues: ImportIssue[] = [];
    const actions: Action[] = [];
    const batchActions: Plan['batchActions'] = [];
    let wouldCreate = 0;
    let wouldSkip = 0;
    let wouldUpdate = 0;
    for (const header of session.headers) {
      if (!SPECS[kind].headers.includes(header)) issues.push(issue(1, 'IMPORT_EXTRA_COLUMN', header));
    }
    const rows = session.rows.map((cells, index) => ({
      number: index + 2,
      value: rowOf(session.headers, cells),
    }));
    if (kind === 'openingStock') {
      await this.assertOpeningNotImported(knex, rows.map((entry) => entry.value));
    }
    const partnerIds = new Map<string, string>();
    for (const { number, value } of rows) {
      const missing = SPECS[kind].required.filter((name) => value[name] === '');
      // 多联系人行只有联系人列、没有 name，仍允许（键必须指向已出现或已存在的单位）。
      const contactOnly = kind === 'partners' && value.name === '' && value.contactName !== '';
      if (missing.length > 0 && !contactOnly) {
        issues.push(issue(number, 'IMPORT_REQUIRED_EMPTY', missing.join(',')));
        continue;
      }
      try {
        if (kind === 'items') {
          await this.planItem(knex, value, number, mode, actions, () => wouldCreate++, () => wouldSkip++, () => wouldUpdate++);
        } else if (kind === 'partners') {
          await this.planPartner(knex, value, number, mode, contactOnly, actions, partnerIds, () => wouldCreate++, () => wouldSkip++, () => wouldUpdate++);
        } else if (kind === 'warehouses') {
          await this.planWarehouse(knex, value, number, mode, actions, () => wouldCreate++, () => wouldSkip++, () => wouldUpdate++);
        } else if (kind === 'bizDict') {
          await this.planDict(knex, value, number, mode, actions, () => wouldCreate++, () => wouldSkip++, () => wouldUpdate++);
        } else {
          await this.planOpening(knex, value, number, issues, batchActions, () => wouldCreate++, () => wouldSkip++);
        }
      } catch (error) {
        if (error instanceof ImportRuleError) {
          issues.push(...error.issues);
        } else {
          throw error;
        }
      }
    }
    const report: ImportReport = {
      kind,
      rowCount: session.rows.length,
      wouldCreate,
      wouldSkip,
      wouldUpdate,
      errorCount: issues.filter((entry) => BLOCKING.has(entry.code)).length,
      issues,
    };
    return { report, actions, batchActions };
  }

  private async planItem(
    knex: Knex,
    value: Row,
    number: number,
    mode: 'skip' | 'update',
    actions: Action[],
    created: () => void,
    skipped: () => void,
    updated: () => void,
  ): Promise<void> {
    const unit = (await knex('units').where({ code: value.unitCode }).first()) as { code: string } | undefined;
    if (unit === undefined) throw new ImportRuleError('IMPORT_UNIT_NOT_FOUND', [issue(number, 'IMPORT_UNIT_NOT_FOUND')]);
    const categoryCodes = [value.categoryCode, value.category2Code, value.category3Code].filter((code) => code !== '');
    for (const code of categoryCodes) {
      const found = (await knex('item_categories').where({ code }).first()) as { code: string } | undefined;
      if (found === undefined) {
        throw new ImportRuleError('IMPORT_CATEGORY_NOT_FOUND', [issue(number, 'IMPORT_CATEGORY_NOT_FOUND')]);
      }
    }
    const numeric = (name: string): number | null => {
      const raw = value[name] ?? '';
      if (raw === '') return null;
      const parsed = Number(raw);
      if (!Number.isFinite(parsed) || parsed < 0) {
        throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', name)]);
      }
      return parsed;
    };
    const prices = {
      basePurchasePrice: numeric('purchasePrice'),
      baseSalesPrice: numeric('salesPrice'),
      stockMin: numeric('stockMin'),
      stockMax: numeric('stockMax'),
    };
    const lead = numeric('leadTimeDays');
    if (lead !== null && !Number.isInteger(lead)) {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'leadTimeDays')]);
    }
    const existing = (value.code !== ''
      ? await knex('items').where({ code: value.code }).first()
      : await knex('items').where({ legacy_code: value.legacyCode }).first()) as
      | { id: string }
      | undefined;
    const patch = {
      spec: value.spec || null,
      note: value.note || null,
      ...prices,
      barcode: value.barcode || null,
      brand: value.brand || null,
      manufacturerModel: value.manufacturerModel || null,
      purchaseLeadDays: lead,
    };
    if (existing !== undefined) {
      if (mode === 'update') {
        actions.push(async (tx) => { await this.itemsMutations.update(existing.id, patch, tx); });
        updated();
      } else {
        skipped();
      }
      return;
    }
    const input = {
      name: value.name,
      itemType: 'material',
      unitCode: value.unitCode,
      categoryCode: categoryCodes.at(-1) ?? null,
      legacyCode: value.legacyCode || null,
      ...patch,
    };
    actions.push(async (tx, _mode, actorId) => {
      await this.itemsMutations.create(input, actorId, tx);
    });
    created();
  }

  private async planPartner(
    knex: Knex,
    value: Row,
    number: number,
    mode: 'skip' | 'update',
    contactOnly: boolean,
    actions: Action[],
    partnerIds: Map<string, string>,
    created: () => void,
    skipped: () => void,
    updated: () => void,
  ): Promise<void> {
    const key = value.code || value.legacyCode;
    const invalid = (detail: string): never => {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', detail)]);
    };
    if (value.contactPhone !== '' && !/^[0-9+\-() ]{6,20}$/u.test(value.contactPhone)) invalid('contactPhone');
    if (value.contactEmail !== '' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value.contactEmail)) invalid('contactEmail');
    const existing = (key === ''
      ? undefined
      : await knex('partners').where({ code: key }).first()) as { id: string } | undefined;
    const knownId = existing?.id ?? partnerIds.get(key ?? '');
    if (contactOnly) {
      if (knownId === undefined) invalid('联系人行没有对应单位');
      const partnerId = knownId!;
      const contact = {
        name: value.contactName,
        phone: value.contactPhone || null,
        email: value.contactEmail || null,
      };
      actions.push(async (tx) => {
        const duplicate = await tx.repository('partnerContacts').findOne({
          filter: { partnerId, name: contact.name, phone: contact.phone ?? '' },
        });
        if (duplicate === undefined) await this.partnerMutations.createContact(partnerId, contact, tx);
      });
      skipped();
      return;
    }
    const isCustomer = value.partnerType === 'customer';
    if (value.partnerType !== 'customer' && value.partnerType !== 'supplier') invalid('partnerType');
    const groupType = isCustomer ? 'customer_group' : 'supplier_group';
    if (value.groupCode !== '') {
      try {
        await assertActiveCodes(this.database.connection(), groupType, [value.groupCode]);
      } catch (error) {
        if (error instanceof BizDictRuleError) {
          throw new ImportRuleError('IMPORT_GROUP_NOT_FOUND', [issue(number, 'IMPORT_GROUP_NOT_FOUND')]);
        }
        throw error;
      }
    }
    const sides = [isCustomer ? 'customers' : 'suppliers'] as const;
    const extras = isCustomer
      ? { customerGroupCode: value.groupCode || null }
      : { supplierGroupCode: value.groupCode || null };
    if (knownId !== undefined) {
      if (mode === 'update') {
        actions.push(async (tx) => {
          await this.partnerMutations.update(knownId, { note: value.note || null, ...extras }, sides, tx);
        });
        updated();
      } else {
        skipped();
      }
    } else {
      const contact = value.contactName === ''
        ? null
        : { name: value.contactName, phone: value.contactPhone || null, email: value.contactEmail || null };
      actions.push(async (tx, _mode, actorId) => {
        const created = await this.partnerMutations.create({
          name: value.name, isCustomer, isSupplier: !isCustomer, note: value.note || null, ...extras,
        }, sides, actorId, tx);
        // CSV 的 code 是旧系统已有的系统码：在同一事务里保留它，后续按码幂等。
        if (value.code !== '') {
          await tx.repository('partners').updateOne({
            filter: { id: created.id }, values: { code: value.code },
          });
        }
        partnerIds.set(key ?? '', created.id);
        if (contact !== null) {
          const duplicate = await tx.repository('partnerContacts').findOne({
            filter: { partnerId: created.id, name: contact.name, phone: contact.phone ?? '' },
          });
          if (duplicate === undefined) await this.partnerMutations.createContact(created.id, contact, tx);
        }
      });
      created();
    }
  }

  private async planWarehouse(
    knex: Knex,
    value: Row,
    number: number,
    mode: 'skip' | 'update',
    actions: Action[],
    created: () => void,
    skipped: () => void,
    updated: () => void,
  ): Promise<void> {
    const status = value.status === '' ? 'active' : value.status;
    if (status !== 'active' && status !== 'inactive') {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'status')]);
    }
    const existing = (await knex('warehouses').where({ code: value.code }).first()) as { id: string } | undefined;
    if (existing !== undefined) {
      if (mode === 'update') {
        actions.push(async (tx) => {
          await this.stockMutations.updateWarehouse(existing.id, {
            name: value.name, status, note: value.note || '',
          }, tx);
        });
        updated();
      } else {
        skipped();
      }
      return;
    }
    actions.push(async (tx) => {
      await this.stockMutations.createWarehouse({
        code: value.code, name: value.name, status, note: value.note || '',
      }, tx);
    });
    created();
  }

  private async planDict(
    knex: Knex,
    value: Row,
    number: number,
    mode: 'skip' | 'update',
    actions: Action[],
    created: () => void,
    skipped: () => void,
    updated: () => void,
  ): Promise<void> {
    let dictType: BizDictType;
    try {
      dictType = assertDictType(value.dictType);
    } catch {
      throw new ImportRuleError('IMPORT_DICT_TYPE_INVALID', [issue(number, 'IMPORT_DICT_TYPE_INVALID')]);
    }
    const rate = value.rate === '' ? undefined : Number(value.rate);
    if (rate !== undefined && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'rate')]);
    }
    const sort = value.sort === '' ? 0 : Number(value.sort);
    if (!Number.isInteger(sort) || sort < 0) {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'sort')]);
    }
    const status = value.status === '' ? 'active' : value.status;
    if (status !== 'active' && status !== 'inactive') {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'status')]);
    }
    try {
      assertApplicableFields(dictType, { rate });
      assertEntryValues({ name: value.name, rate });
    } catch (error) {
      if (error instanceof BizDictRuleError) {
        throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID')]);
      }
      throw error;
    }
    const existing = (await knex('biz_dict_entries').where({ dict_type: dictType, code: value.code }).first()) as { id: string } | undefined;
    if (existing !== undefined) {
      if (mode === 'update') {
        actions.push(async (tx) => {
          await this.dicts.update(existing.id, {
            name: value.name, rate: rate ?? null, sort, status,
          }, tx);
        });
        updated();
      } else {
        skipped();
      }
      return;
    }
    actions.push(async (tx, _mode, actorId) => {
      await this.dicts.create({
        dictType, code: value.code, name: value.name, rate, sort,
      }, actorId, tx);
    });
    created();
  }

  private async assertOpeningNotImported(knex: Knex, rows: readonly Row[]): Promise<void> {
    const codes = [...new Set(rows.map((row) => row.warehouseCode).filter((code) => code !== ''))];
    if (codes.length === 0) return;
    const warehouses = (await knex('warehouses').select('id').whereIn('code', codes)) as readonly { id: string }[];
    const ids = warehouses.map((row) => row.id);
    if (ids.length === 0) return;
    const transactions = (await knex('stock_transactions').select('id').whereIn('warehouse_id', ids).limit(1)) as readonly unknown[];
    if (transactions.length > 0) throw new ImportRuleError('OPENING_ALREADY_IMPORTED');
    const balances = (await knex('stock_balances')
      .select('warehouse_id').whereIn('warehouse_id', ids).where('qty', '<>', 0).limit(1)) as readonly unknown[];
    if (balances.length > 0) throw new ImportRuleError('OPENING_ALREADY_IMPORTED');
  }

  private async planOpening(
    knex: Knex,
    value: Row,
    number: number,
    issues: ImportIssue[],
    batchActions: Plan['batchActions'],
    created: () => void,
    skipped: () => void,
  ): Promise<void> {
    const qty = Number(value.qty);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'qty')]);
    }
    if (qty === 0) {
      skipped();
      issues.push(issue(number, 'IMPORT_ZERO_QTY_SKIPPED'));
      return;
    }
    const DATE = /^\d{4}-\d{2}-\d{2}$/u;
    for (const field of ['productionDate', 'expiryDate'] as const) {
      if (value[field] !== '' && !DATE.test(value[field])) {
        throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', field)]);
      }
    }
    if (
      value.productionDate !== '' && value.expiryDate !== '' &&
      value.expiryDate < value.productionDate
    ) {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'expiryDate')]);
    }
    if (value.batchNo.length > 64) {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'batchNo')]);
    }
    const warehouse = (await knex('warehouses').where({ code: value.warehouseCode }).first()) as { id: string; status: string } | undefined;
    if (warehouse === undefined || warehouse.status !== 'active') {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'warehouseCode')]);
    }
    const item = (value.itemCode.includes('-')
      ? await knex('items').where({ code: value.itemCode }).first()
      : await knex('items').where({ legacy_code: value.itemCode }).first()) as
      | { id: string; status: string }
      | undefined;
    if (item === undefined || item.status !== 'active') {
      throw new ImportRuleError('IMPORT_VALUE_INVALID', [issue(number, 'IMPORT_VALUE_INVALID', 'itemCode')]);
    }
    const line = {
      itemId: item.id,
      warehouseId: warehouse.id,
      batchNo: value.batchNo,
      qty,
      productionDate: value.productionDate || null,
      expiryDate: value.expiryDate || null,
      note: value.note || null,
    };
    batchActions.push(async (tx, _mode, actorId) => {
      const doc = await this.stockMutations.createDoc({
        docType: 'in',
        reason: 'other_in',
        remark: '期初入库',
        lines: [line],
      }, actorId, tx);
      await this.stockMutations.post(doc.id, actorId, tx);
    });
    created();
  }
}

export const importToolToken: ServiceToken<ImportToolService> =
  createServiceToken<ImportToolService>('app/import-tool');

export default class ImportToolProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.import-tool';

  public override register(): void {
    this.app.container.singleton(importToolToken, () => {
      const logger: ImportLogger = this.app.container.has(loggingToken)
        ? this.app.container.resolve(loggingToken).getLogger('imports')
        : { info: (bindings, message) => console.info(message, bindings) };
      return new DatabaseImportToolService(
        this.app.container.resolve(databaseManagerToken),
        this.app.container.resolve(itemsMutationsToken),
        this.app.container.resolve(partnerMutationsToken),
        this.app.container.resolve(stockMutationsToken),
        this.app.container.resolve(bizDictReaderToken),
        logger,
      );
    });
  }
}
