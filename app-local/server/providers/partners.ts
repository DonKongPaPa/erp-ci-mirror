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

import { codeServiceToken, CODE_PREFIXES, type CodeService } from './codes.js';

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
 * 客户/供应商的授权在路由层按资源（customers / suppliers）判定；这里只做数据规则。
 */
export type PartnerStatus = 'active' | 'inactive';
export type PartnerKindResource = 'customers' | 'suppliers';

export type PartnerRuleCode =
  | 'kind-required'
  | 'invalid-name'
  | 'code-taken'
  | 'partner-not-found'
  | 'partner-inactive'
  | 'contact-not-found'
  | 'invalid-update';

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

/** 库里的主档行：比读出的副本多一个建单人标识。 */
interface PartnerRow extends PartnerRecord {
  readonly createdById: string | null;
}

export interface PartnerDetail extends PartnerRecord {
  readonly contacts: readonly ContactRecord[];
}

export interface PartnerListQuery {
  readonly kind?: 'customer' | 'supplier';
  readonly q?: string;
  readonly status?: PartnerStatus;
  readonly page: number;
  readonly pageSize: number;
}

export interface CreatePartnerInput {
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

export interface UpdatePartnerInput {
  readonly name?: string;
  readonly status?: PartnerStatus;
  readonly contactName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly taxId?: string | null;
  readonly note?: string | null;
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
  list(query: PartnerListQuery): Promise<{
    readonly items: readonly PartnerRecord[];
    readonly total: number;
  }>;
  detail(id: string): Promise<PartnerDetail | undefined>;
}

export interface PartnerMutations {
  create(input: CreatePartnerInput, actorId?: string): Promise<PartnerRecord>;
  update(
    id: string,
    input: UpdatePartnerInput,
    transaction?: DatabaseConnection,
  ): Promise<PartnerRecord>;
  createContact(
    partnerId: string,
    input: CreateContactInput,
  ): Promise<ContactRecord>;
  updateContact(
    partnerId: string,
    contactId: string,
    input: UpdateContactInput,
  ): Promise<ContactRecord>;
}

const iso = (value: string | Date): string =>
  value instanceof Date ? value.toISOString() : String(value);

/** 逐列拼副本：调用方改返回值不会写回库，也不会漏出 createdById。 */
function view(row: PartnerRecord): PartnerRecord {
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
  public constructor(private readonly database: DatabaseManager) {}

  public async list(query: PartnerListQuery): Promise<{
    readonly items: readonly PartnerRecord[];
    readonly total: number;
  }> {
    let rows = [
      ...(await this.database.repository<PartnerRecord>('partners').findMany()),
    ];
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
    rows.sort((left, right) =>
      left.code < right.code ? -1 : left.code > right.code ? 1 : 0,
    );
    const start = (query.page - 1) * query.pageSize;
    return {
      items: rows.slice(start, start + query.pageSize).map(view),
      total: rows.length,
    };
  }

  public async detail(id: string): Promise<PartnerDetail | undefined> {
    const row = await this.database
      .repository<PartnerRecord>('partners')
      .findOne({ filter: { id } });
    if (row === undefined) {
      return undefined;
    }
    const contacts = await this.database
      .repository<ContactRecord>('partnerContacts')
      .findMany({ filter: { partnerId: id } });
    contacts.sort((left, right) => (left.id < right.id ? -1 : 1));
    return { ...view(row), contacts: contacts.map(viewContact) };
  }
}

export class DatabasePartnerMutations implements PartnerMutations {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
  ) {}

  public async create(input: CreatePartnerInput, actorId?: string): Promise<PartnerRecord> {
    return await this.database.transaction(async (tx) => {
      if (!input.isCustomer && !input.isSupplier) {
        return fail('kind-required');
      }
      const name = input.name.trim();
      if (name.length < 1) {
        return fail('invalid-name');
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
          },
        })
        .catch((error: unknown) => {
          if (isUniqueConstraintViolation(error)) {
            return fail('code-taken');
          }
          throw error;
        });
      return view(row.record);
    });
  }

  public async update(
    id: string,
    input: UpdatePartnerInput,
    transaction?: DatabaseConnection,
  ): Promise<PartnerRecord> {
    const work = async (tx: DatabaseConnection): Promise<PartnerRecord> => {
      await this.require(tx, id);
      const values: Record<string, unknown> = {};
      for (const key of UPDATABLE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
          values[key] = (input as unknown as Record<string, unknown>)[key];
        }
      }
      if (Object.keys(values).length === 0) {
        return fail('invalid-update');
      }
      values.updatedAt = new Date();
      const { record } = await tx
        .repository<PartnerRecord>('partners')
        .updateOne({ filter: { id }, values });
      return view(record);
    };
    return transaction === undefined
      ? await this.database.transaction(work)
      : await work(transaction);
  }

  public async createContact(
    partnerId: string,
    input: CreateContactInput,
  ): Promise<ContactRecord> {
    return await this.database.transaction(async (tx) => {
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

  private async require(
    tx: DatabaseConnection,
    id: string,
  ): Promise<PartnerRecord> {
    const row = await tx.repository<PartnerRecord>('partners').findOne({ filter: { id } });
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
      return new DatabasePartnerReader(database);
    });
    this.app.container.singleton(partnerMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const codes = this.app.container.resolve(codeServiceToken);
      return new DatabasePartnerMutations(database, codes);
    });
  }
}
