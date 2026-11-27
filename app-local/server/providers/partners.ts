import { randomUUID } from 'node:crypto';

import type { Application } from '@nocobase/app-server/application';
import {
  databaseManagerToken,
  isUniqueConstraintViolation,
  type DatabaseConnection,
  type DatabaseManager,
} from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';

import { assertActiveCodes, BizDictRuleError } from './biz-dict.js';
import { codeServiceToken, CODE_PREFIXES, type CodeService } from './codes.js';
import { employeeServiceToken, type EmployeeService } from './employee-service.js';

/**
 * R-014 MVP：往来单位的读服务与写服务。
 *
 * 读服务只回业务列（没有 createdById 这个人员标识）与联系人；列表在内存里按
 * kind / status / q 过滤、按编码排序后分页（MVP 数据量小，不拼 SQL like）。
 *
 * 写服务把校验、事务与发号放在一起：
 * - 建行在事务里经 R-016 的统一发号器领号（客户 CU、供应商 SU，两者都是用 CU）；
 *   code 的唯一约束再兜一层并发冲突；
 * - 联系人只能挂在在用单位上；改主联系人时先把同单位的其它主联系人清掉；
 * - 停用与启用都走 update，没有删除端点。
 *
 * 复刻波 0 加片：新增两列分组码、两列人员账号标识与收款三列，以及一张交货地址表。
 * 分组码走共享的 assertActiveCodes，人员列只收在职员工，姓名从在职员工选项里取；
 * 读与写都按调用者持有的一侧裁列（sides），另一侧的值既不回显也不落库。
 *
 * 客户/供应商的授权在路由层按资源（customers / suppliers）判定；这里只做数据规则。
 */
export type PartnerStatus = 'active' | 'inactive';
export type PartnerKindResource = 'customers' | 'suppliers';
export type PartnerSide = 'customers' | 'suppliers';

export type PartnerRuleCode =
  | 'kind-required'
  | 'invalid-name'
  | 'code-taken'
  | 'partner-not-found'
  | 'partner-inactive'
  | 'contact-not-found'
  | 'invalid-update'
  | 'dict-code-invalid'
  | 'person-invalid'
  | 'address-not-found';

export class PartnerRuleError extends Error {
  public constructor(
    readonly code: PartnerRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Partner rule violated: ${code}`);
    this.name = 'PartnerRuleError';
  }
}

function fail(code: PartnerRuleCode, detail?: string): never {
  throw new PartnerRuleError(code, detail);
}

/** 主档的业务列；createdById 只在库里，不进任何响应。 */
export interface PartnerRecord {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
  readonly status: PartnerStatus;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly taxId: string | null;
  readonly note: string | null;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface ContactRecord {
  readonly id: string;
  readonly partnerId: string;
  readonly name: string;
  readonly title: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly isPrimary: boolean;
}

/** 人员的对外形状只有两列：账号标识与姓名，不含邮箱、工号、部门、用户名。 */
export interface PersonRef {
  readonly userId: string;
  readonly name: string | null;
}

export type AddressStatus = 'active' | 'inactive';

export interface AddressRecord {
  readonly id: string;
  readonly partnerId: string;
  readonly address: string;
  readonly isDefault: boolean;
  readonly status: AddressStatus;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

/** 库里的主档行：比读出的副本多建单人标识与加片的七列原始值。 */
interface PartnerRow extends PartnerRecord {
  readonly createdById: string | null;
  readonly customerGroupCode: string | null;
  readonly supplierGroupCode: string | null;
  readonly salespersonUserId: string | null;
  readonly buyerUserId: string | null;
  readonly payeeAccountNo: string | null;
  readonly payeeBankName: string | null;
  readonly payeeBankCode: string | null;
}

/** 对外多出的键：人员列从原始账号标识换成 { userId, name }。 */
export interface PartnerExtraView {
  readonly customerGroupCode: string | null;
  readonly supplierGroupCode: string | null;
  readonly salesperson: PersonRef | null;
  readonly buyer: PersonRef | null;
  readonly payeeAccountNo: string | null;
  readonly payeeBankName: string | null;
  readonly payeeBankCode: string | null;
}

/** 按侧裁列后：只有值非空且属于调用者一侧的键才出现，老客户端看到的形状不变。 */
export type PartnerView = PartnerRecord & Partial<PartnerExtraView>;

export interface PartnerDetailView extends PartnerView {
  readonly contacts: readonly ContactRecord[];
  readonly addresses?: readonly AddressRecord[];
}

/** 服务内部先拼全列，再由 reader 按侧裁。 */
type PartnerRawView = PartnerRecord & {
  readonly customerGroupCode: string | null;
  readonly supplierGroupCode: string | null;
  readonly salespersonUserId: string | null;
  readonly buyerUserId: string | null;
  readonly payeeAccountNo: string | null;
  readonly payeeBankName: string | null;
  readonly payeeBankCode: string | null;
};

export interface PartnerListQuery {
  readonly kind?: 'customer' | 'supplier';
  readonly q?: string;
  readonly status?: PartnerStatus;
  readonly customerGroupCode?: string;
  readonly supplierGroupCode?: string;
  readonly salespersonUserId?: string;
  readonly buyerUserId?: string;
  readonly page: number;
  readonly pageSize: number;
}

/** 七个新列都是可选；不属于本单位/调用者一侧的键在服务层被剥掉。 */
export interface PartnerExtraInput {
  readonly customerGroupCode?: string | null;
  readonly supplierGroupCode?: string | null;
  readonly salespersonUserId?: string | null;
  readonly buyerUserId?: string | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
}

export interface CreatePartnerInput extends PartnerExtraInput {
  readonly name: string;
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
  readonly contactName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly taxId?: string | null;
  readonly note?: string | null;
}

export interface UpdatePartnerInput extends PartnerExtraInput {
  readonly name?: string;
  readonly status?: PartnerStatus;
  readonly contactName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly taxId?: string | null;
  readonly note?: string | null;
}

export interface CreateAddressInput {
  readonly address: string;
  readonly isDefault?: boolean;
}

export interface UpdateAddressInput {
  readonly address?: string;
  readonly isDefault?: boolean;
  readonly status?: AddressStatus;
}

export interface CreateContactInput {
  readonly name: string;
  readonly title?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly isPrimary?: boolean;
}

export interface UpdateContactInput {
  readonly name?: string;
  readonly title?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly isPrimary?: boolean;
}

export interface PartnerReader {
  list(
    query: PartnerListQuery,
    sides?: readonly PartnerSide[],
  ): Promise<{
    readonly items: readonly PartnerView[];
    readonly total: number;
  }>;
  detail(id: string, sides?: readonly PartnerSide[]): Promise<PartnerDetailView | undefined>;
}

export interface PartnerMutations {
  create(
    input: CreatePartnerInput,
    sides: readonly PartnerSide[],
    actorId?: string,
    transaction?: DatabaseConnection,
  ): Promise<PartnerView>;
  update(
    id: string,
    input: UpdatePartnerInput,
    sides: readonly PartnerSide[],
    transaction?: DatabaseConnection,
  ): Promise<PartnerView>;
  createContact(
    partnerId: string,
    input: CreateContactInput,
    transaction?: DatabaseConnection,
  ): Promise<ContactRecord>;
  updateContact(
    partnerId: string,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<ContactRecord>;
  createAddress(
    partnerId: string,
    input: CreateAddressInput,
  ): Promise<AddressRecord>;
  updateAddress(
    partnerId: string,
    addressId: string,
    input: UpdateAddressInput,
  ): Promise<AddressRecord>;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : String(value);

/** 逐列拼副本：调用方改返回值不会写回库，也不会漏出 createdById。 */
function view(row: PartnerRow): PartnerRawView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isCustomer: Boolean(row.isCustomer),
    isSupplier: Boolean(row.isSupplier),
    status: row.status,
    contactName: row.contactName ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    address: row.address ?? null,
    taxId: row.taxId ?? null,
    note: row.note ?? null,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    customerGroupCode: row.customerGroupCode ?? null,
    supplierGroupCode: row.supplierGroupCode ?? null,
    salespersonUserId: row.salespersonUserId ?? null,
    buyerUserId: row.buyerUserId ?? null,
    payeeAccountNo: row.payeeAccountNo ?? null,
    payeeBankName: row.payeeBankName ?? null,
    payeeBankCode: row.payeeBankCode ?? null,
  };
}

function viewContact(row: ContactRecord): ContactRecord {
  return {
    id: row.id,
    partnerId: row.partnerId,
    name: row.name,
    title: row.title ?? null,
    phone: row.phone ?? null,
    email: row.email ?? null,
    isPrimary: Boolean(row.isPrimary),
  };
}

function viewAddress(row: AddressRecord): AddressRecord {
  return {
    id: row.id,
    partnerId: row.partnerId,
    address: row.address,
    isDefault: Boolean(row.isDefault),
    status: row.status,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

const ALL_SIDES: readonly PartnerSide[] = ['customers', 'suppliers'];

/**
 * 按调用者的一侧裁列：客户侧键只在「本单位是客户且持 customers」时出现，供应商侧同理。
 * 人员列只回 { userId, name }；值为空的键不出现，老客户端读老行看到的形状不变。
 */
function project(
  row: PartnerRawView,
  sides: readonly PartnerSide[],
  names: ReadonlyMap<string, string | null>,
): PartnerView {
  const {
    customerGroupCode,
    supplierGroupCode,
    salespersonUserId,
    buyerUserId,
    payeeAccountNo,
    payeeBankName,
    payeeBankCode,
    ...base
  } = row;
  const result: Record<string, unknown> = { ...base };
  const put = (key: string, value: unknown): void => {
    if (value !== null && value !== undefined) {
      result[key] = value;
    }
  };
  const person = (userId: string): PersonRef => ({
    userId,
    name: names.get(userId) ?? null,
  });
  if (row.isCustomer && sides.includes('customers')) {
    put('customerGroupCode', customerGroupCode);
    if (salespersonUserId !== null) {
      put('salesperson', person(salespersonUserId));
    }
  }
  if (row.isSupplier && sides.includes('suppliers')) {
    put('supplierGroupCode', supplierGroupCode);
    if (buyerUserId !== null) {
      put('buyer', person(buyerUserId));
    }
    put('payeeAccountNo', payeeAccountNo);
    put('payeeBankName', payeeBankName);
    put('payeeBankCode', payeeBankCode);
  }
  return result as unknown as PartnerView;
}

const UPDATABLE_KEYS = [
  'name',
  'status',
  'contactName',
  'phone',
  'email',
  'address',
  'taxId',
  'note',
] as const;

export class DatabasePartnerReader implements PartnerReader {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly employees: EmployeeService,
  ) {}

  private async namesOf(userIds: readonly string[]): Promise<Map<string, string | null>> {
    const wanted = [...new Set(userIds)].filter((id) => id !== '');
    if (wanted.length === 0) {
      return new Map();
    }
    // 只取在职员工选项：这里只回账号标识与姓名，邮箱、工号、部门根本不查。
    const options = await this.employees.activePersonOptions(wanted);
    return new Map(options.map((option) => [option.userId, option.name] as const));
  }

  public async list(
    query: PartnerListQuery,
    sides: readonly PartnerSide[] = ALL_SIDES,
  ): Promise<{
    readonly items: readonly PartnerView[];
    readonly total: number;
  }> {
    let rows = [...(await this.database.repository<PartnerRow>('partners').findMany())];
    if (query.kind === 'customer') {
      rows = rows.filter((row) => row.isCustomer);
    } else if (query.kind === 'supplier') {
      rows = rows.filter((row) => row.isSupplier);
    }
    if (query.status !== undefined) {
      rows = rows.filter((row) => row.status === query.status);
    }
    if (query.q !== undefined && query.q !== '') {
      const term = query.q.toLowerCase();
      rows = rows.filter(
        (row) =>
          row.name.toLowerCase().includes(term) ||
          row.code.toLowerCase().includes(term),
      );
    }
    for (const key of [
      'customerGroupCode',
      'supplierGroupCode',
      'salespersonUserId',
      'buyerUserId',
    ] as const) {
      if (query[key] !== undefined) {
        rows = rows.filter((row) => row[key] === query[key]);
      }
    }
    rows.sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
    const start = (query.page - 1) * query.pageSize;
    const page = rows.slice(start, start + query.pageSize);
    const names = await this.namesOf([
      ...page.map((row) => row.salespersonUserId ?? ''),
      ...page.map((row) => row.buyerUserId ?? ''),
    ]);
    return {
      items: page.map((row) => project(view(row), sides, names)),
      total: rows.length,
    };
  }

  public async detail(
    id: string,
    sides: readonly PartnerSide[] = ALL_SIDES,
  ): Promise<PartnerDetailView | undefined> {
    const row = await this.database
      .repository<PartnerRow>('partners')
      .findOne({ filter: { id } });
    if (row === undefined) {
      return undefined;
    }
    const contacts = await this.database
      .repository<ContactRecord>('partnerContacts')
      .findMany({ filter: { partnerId: id } });
    contacts.sort((left, right) => (left.id < right.id ? -1 : 1));
    const rawAddresses = await this.database
      .repository<AddressRecord>('partnerAddresses')
      .findMany({ filter: { partnerId: id } });
    // 默认地址在前，其余按 id 升序；停用的地址照旧回，不在这里过滤。
    rawAddresses.sort((left, right) => {
      if (left.isDefault !== right.isDefault) {
        return left.isDefault ? -1 : 1;
      }
      return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
    });
    const names = await this.namesOf([
      row.salespersonUserId ?? '',
      row.buyerUserId ?? '',
    ]);
    const result: PartnerDetailView = {
      ...project(view(row), sides, names),
      contacts: contacts.map(viewContact),
    };
    // 交货地址是客户侧数据：是客户且持客户侧就一直给这个键，没有地址时是空数组，
    // 页面才有「新增交货地址」的入口；采购侧照旧没有这个键（反向断言不变）。
    if (row.isCustomer && sides.includes('customers')) {
      return { ...result, addresses: rawAddresses.map(viewAddress) };
    }
    return result;
  }
}

export class DatabasePartnerMutations implements PartnerMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly employees: EmployeeService,
  ) {}

  private async namesOf(userIds: readonly string[]): Promise<Map<string, string | null>> {
    const wanted = [...new Set(userIds)].filter((id) => id !== '');
    if (wanted.length === 0) {
      return new Map();
    }
    const options = await this.employees.activePersonOptions(wanted);
    return new Map(options.map((option) => [option.userId, option.name] as const));
  }

  /** 分组码必须在该字典类型里在用；复用了 R-072 的共享校验，不复制逻辑。 */
  private async assertDict(
    tx: DatabaseConnection,
    dictType: string,
    code: string,
  ): Promise<void> {
    try {
      await assertActiveCodes(tx, dictType, [code]);
    } catch (error) {
      if (error instanceof BizDictRuleError && error.code === 'code-inactive') {
        return fail('dict-code-invalid', code);
      }
      throw error;
    }
  }

  /** 人员列只收在职员工；姓名在 reader 里从同一口径的选项取，不回其它人员列。 */
  private async assertPerson(userId: string): Promise<void> {
    if (!(await this.employees.isActive(userId))) {
      return fail('person-invalid', userId);
    }
  }

  private async inTransaction<T>(
    transaction: DatabaseConnection | undefined,
    work: (tx: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    if (transaction !== undefined) return await work(transaction);
    return await this.database.transaction(work);
  }

  public async create(
    input: CreatePartnerInput,
    sides: readonly PartnerSide[],
    actorId?: string,
    transaction?: DatabaseConnection,
  ): Promise<PartnerView> {
    return await this.inTransaction(transaction, async (tx) => {
      if (!input.isCustomer && !input.isSupplier) {
        return fail('kind-required');
      }
      const name = input.name.trim();
      if (name.length < 1) {
        return fail('invalid-name');
      }
      const customerSide = input.isCustomer && sides.includes('customers');
      const supplierSide = input.isSupplier && sides.includes('suppliers');
      const customerGroup =
        customerSide && input.customerGroupCode != null ? input.customerGroupCode : null;
      const supplierGroup =
        supplierSide && input.supplierGroupCode != null ? input.supplierGroupCode : null;
      const salesperson =
        customerSide && input.salespersonUserId != null ? input.salespersonUserId : null;
      const buyer =
        supplierSide && input.buyerUserId != null ? input.buyerUserId : null;
      if (customerGroup !== null) {
        await this.assertDict(tx, 'customer_group', customerGroup);
      }
      if (supplierGroup !== null) {
        await this.assertDict(tx, 'supplier_group', supplierGroup);
      }
      if (salesperson !== null) {
        await this.assertPerson(salesperson);
      }
      if (buyer !== null) {
        await this.assertPerson(buyer);
      }
      const code = await this.codes.nextCode(
        tx,
        input.isCustomer ? CODE_PREFIXES.customer : CODE_PREFIXES.supplier,
      );
      const now = new Date();
      const row = await tx
        .repository<PartnerRow>('partners')
        .createOne({
          values: {
            id: randomId(),
            code,
            name,
            isCustomer: input.isCustomer,
            isSupplier: input.isSupplier,
            status: 'active',
            contactName: input.contactName ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            address: input.address ?? null,
            taxId: input.taxId ?? null,
            note: input.note ?? null,
            createdById: actorId ?? null,
            createdAt: now,
            updatedAt: now,
            customerGroupCode: customerGroup,
            supplierGroupCode: supplierGroup,
            salespersonUserId: salesperson,
            buyerUserId: buyer,
            payeeAccountNo: supplierSide ? (input.payeeAccountNo ?? null) : null,
            payeeBankName: supplierSide ? (input.payeeBankName ?? null) : null,
            payeeBankCode: supplierSide ? (input.payeeBankCode ?? null) : null,
          },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) {
            return fail('code-taken');
          }
          throw error;
        });
      // 建行回显也按侧裁：sales 建的供应商不该从响应里读到收款列。
      return project(
        view(row.record),
        sides,
        await this.namesOf([salesperson ?? '', buyer ?? '']),
      );
    });
  }

  public async update(
    id: string,
    input: UpdatePartnerInput,
    sides: readonly PartnerSide[],
    transaction?: DatabaseConnection,
  ): Promise<PartnerView> {
    const work = async (tx: DatabaseConnection): Promise<PartnerView> => {
      const row = await this.require(tx, id);
      const raw = input as unknown as Record<string, unknown>;
      if (Object.keys(raw).length === 0) {
        return fail('invalid-update');
      }
      const values: Record<string, unknown> = {};
      for (const key of UPDATABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(raw, key)) {
          values[key] = raw[key];
        }
      }

      // 另一侧或本单位不是那一侧的键一律剥掉；只有一个空 PATCH 才报 invalid-update。
      const customerSide = row.isCustomer && sides.includes('customers');
      const supplierSide = row.isSupplier && sides.includes('suppliers');
      const extras: Record<string, unknown> = {};
      for (const [key, allowed] of [
        ['customerGroupCode', customerSide],
        ['salespersonUserId', customerSide],
        ['supplierGroupCode', supplierSide],
        ['buyerUserId', supplierSide],
        ['payeeAccountNo', supplierSide],
        ['payeeBankName', supplierSide],
        ['payeeBankCode', supplierSide],
      ] as const) {
        if (allowed && Object.prototype.hasOwnProperty.call(raw, key)) {
          extras[key] = raw[key];
        }
      }
      // zod 已把这四个键限成 string | null；这里只需收窄类型，不做隐式 stringify。
      if (extras.customerGroupCode != null) {
        await this.assertDict(tx, 'customer_group', extras.customerGroupCode as string);
      }
      if (extras.supplierGroupCode != null) {
        await this.assertDict(tx, 'supplier_group', extras.supplierGroupCode as string);
      }
      if (extras.salespersonUserId != null) {
        await this.assertPerson(extras.salespersonUserId as string);
      }
      if (extras.buyerUserId != null) {
        await this.assertPerson(extras.buyerUserId as string);
      }
      Object.assign(values, extras);

      const names = async (target: PartnerRow): Promise<Map<string, string | null>> =>
        await this.namesOf([target.salespersonUserId ?? '', target.buyerUserId ?? '']);
      if (Object.keys(values).length === 0) {
        // 带进来的全是另一侧的键：值不变、不报错、响应也不回那个键。
        return project(view(row), sides, await names(row));
      }
      values.updatedAt = new Date();
      const { record } = await tx
        .repository<PartnerRow>('partners')
        .updateOne({ filter: { id }, values });
      return project(view(record), sides, await names(record));
    };
    return await this.inTransaction(transaction, work);
  }

  public async createContact(
    partnerId: string,
    input: CreateContactInput,
    transaction?: DatabaseConnection,
  ): Promise<ContactRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.requireActive(tx, partnerId);
      if (input.isPrimary === true) {
        await this.clearPrimary(tx, partnerId);
      }
      const { record } = await tx
        .repository<ContactRecord>('partnerContacts')
        .createOne({
          values: {
            id: randomId(),
            partnerId,
            name: input.name.trim(),
            title: input.title ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            isPrimary: input.isPrimary ?? false,
          },
        });
      return viewContact(record);
    });
  }

  public async updateContact(
    partnerId: string,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<ContactRecord> {
    return await this.database.transaction(async (tx) => {
      await this.requireActive(tx, partnerId);
      const contact = await tx
        .repository<ContactRecord>('partnerContacts')
        .findOne({ filter: { id: contactId, partnerId } });
      if (contact === undefined) {
        return fail('contact-not-found');
      }
      if (input.isPrimary === true) {
        await this.clearPrimary(tx, partnerId, contactId);
      }
      const values: Record<string, unknown> = {};
      for (const key of ['name', 'title', 'phone', 'email', 'isPrimary'] as const) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          values[key] = (input as unknown as Record<string, unknown>)[key];
        }
      }
      if (Object.keys(values).length === 0) {
        return fail('invalid-update');
      }
      const { record } = await tx
        .repository<ContactRecord>('partnerContacts')
        .updateOne({ filter: { id: contactId, partnerId }, values });
      return viewContact(record);
    });
  }

  public async createAddress(
    partnerId: string,
    input: CreateAddressInput,
  ): Promise<AddressRecord> {
    return await this.database.transaction(async (tx) => {
      await this.requireActive(tx, partnerId);
      if (input.isDefault === true) {
        await this.clearAddressDefault(tx, partnerId);
      }
      const now = new Date();
      const { record } = await tx
        .repository<AddressRecord>('partnerAddresses')
        .createOne({
          values: {
            id: randomId(),
            partnerId,
            address: input.address.trim(),
            isDefault: input.isDefault ?? false,
            status: 'active',
            createdAt: now,
            updatedAt: now,
          },
        });
      return viewAddress(record);
    });
  }

  public async updateAddress(
    partnerId: string,
    addressId: string,
    input: UpdateAddressInput,
  ): Promise<AddressRecord> {
    return await this.database.transaction(async (tx) => {
      await this.requireActive(tx, partnerId);
      const address = await tx
        .repository<AddressRecord>('partnerAddresses')
        .findOne({ filter: { id: addressId, partnerId } });
      if (address === undefined) {
        return fail('address-not-found', addressId);
      }
      if (input.isDefault === true) {
        await this.clearAddressDefault(tx, partnerId, addressId);
      }
      const values: Record<string, unknown> = {};
      for (const key of ['address', 'isDefault', 'status'] as const) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          values[key] = (input as unknown as Record<string, unknown>)[key];
        }
      }
      if (Object.keys(values).length === 0) {
        return fail('invalid-update');
      }
      values.updatedAt = new Date();
      const { record } = await tx
        .repository<AddressRecord>('partnerAddresses')
        .updateOne({ filter: { id: addressId, partnerId }, values });
      return viewAddress(record);
    });
  }

  private async require(
    tx: DatabaseConnection,
    id: string,
  ): Promise<PartnerRow> {
    const row = await tx.repository<PartnerRow>('partners').findOne({ filter: { id } });
    if (row === undefined) {
      return fail('partner-not-found');
    }
    return row;
  }

  private async requireActive(
    tx: DatabaseConnection,
    id: string,
  ): Promise<PartnerRecord> {
    const row = await this.require(tx, id);
    if (row.status !== 'active') {
      return fail('partner-inactive');
    }
    return row;
  }

  /** 新设主联系人时清掉同单位其它主联系人；不碰正在改的那一条。 */
  private async clearPrimary(
    tx: DatabaseConnection,
    partnerId: string,
    exceptId?: string,
  ): Promise<void> {
    const rows = await tx
      .repository<ContactRecord>('partnerContacts')
      .findMany({ filter: { partnerId, isPrimary: true } });
    for (const row of rows) {
      if (row.id === exceptId) {
        continue;
      }
      await tx
        .repository<ContactRecord>('partnerContacts')
        .updateOne({ filter: { id: row.id }, values: { isPrimary: false } });
    }
  }

  /** 新设默认交货地址时清掉同单位其它默认；不碰正在改的那一条。 */
  private async clearAddressDefault(
    tx: DatabaseConnection,
    partnerId: string,
    exceptId?: string,
  ): Promise<void> {
    const rows = await tx
      .repository<AddressRecord>('partnerAddresses')
      .findMany({ filter: { partnerId, isDefault: true } });
    for (const row of rows) {
      if (row.id === exceptId) {
        continue;
      }
      await tx
        .repository<AddressRecord>('partnerAddresses')
        .updateOne({ filter: { id: row.id }, values: { isDefault: false } });
    }
  }
}

/** 随机标识：主键不是编码，编码由发号器给。 */
const randomId = (): string => randomUUID();

export const partnerReaderToken: ServiceToken<PartnerReader> =
  createServiceToken<PartnerReader>('app/partner-reader');
export const partnerMutationsToken: ServiceToken<PartnerMutations> =
  createServiceToken<PartnerMutations>('app/partner-mutations');

export default class PartnersProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.partners';

  public override register(): void {
    this.app.container.singleton(partnerReaderToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const employees = this.app.container.resolve(employeeServiceToken);
      return new DatabasePartnerReader(database, employees);
    });
    this.app.container.singleton(partnerMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      const employees = this.app.container.resolve(employeeServiceToken);
      return new DatabasePartnerMutations(database, codes, employees);
    });
  }
}
