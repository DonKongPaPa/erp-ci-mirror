import { randomUUID } from 'node:crypto';

import { authorizationToken, type AppAuthorization } from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import {
  databaseManagerToken,
  type DatabaseConnection,
  type DatabaseManager,
  type RepositoryPolicy,
} from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';
import type { Knex } from 'knex';

import { activeIdsOf } from '../active-users.js';
import { approvalsServiceToken, type ApprovalsService } from '../approvals-service.js';
import { assertActiveCodes } from './biz-dict.js';
import { CODE_PREFIXES, codeServiceToken, type CodeService } from './codes.js';
import { docFilesToken, type DocFiles, type DocFileView } from './doc-files.js';
import { roundAmount } from './doc-amounts.js';
import { financeMutationsToken, type FinanceMutations } from './finance.js';

/**
 * R-066：请款单与报销单的读写服务。
 *
 * 只在两处接 R-017：submit 建审批单、审批终态由 lifecycle 在转移事务里回调写回。
 * 审批人取持 finance 角色的在岗员工与 root，单节点、无阈值；解析不到就拒绝提交。
 * 转出走 R-065 的建单服务，落一张不自动登记的草稿，附件不复制、收款方留空。
 */
export type RequestDocType = 'payment_request' | 'expense_claim';
export type RequestStatus =
  | 'draft' | 'approving' | 'approved' | 'rejected' | 'void' | 'converted';

export type FinanceRequestRuleCode =
  | 'not-found'
  | 'not-editable'
  | 'amount-invalid'
  | 'person-invalid'
  | 'dict-code-invalid'
  | 'not-approved'
  | 'converted'
  | 'approval-failed';

export class FinanceRequestRuleError extends Error {
  public constructor(
    readonly code: FinanceRequestRuleCode,
    readonly detail?: string,
  ) {
    super(
      detail === undefined
        ? `Finance request rule violated: ${code}`
        : `Finance request rule violated: ${code} (${detail})`,
    );
    this.name = 'FinanceRequestRuleError';
  }
}

function fail(code: FinanceRequestRuleCode, detail?: string): never {
  throw new FinanceRequestRuleError(code, detail);
}

/** 仓储按集合字段名返回 camelCase；原始 knex 行在 convert 里另用 RawRow。 */
interface RequestRow {
  id: string;
  docType: RequestDocType;
  docNo: string;
  requestDate: string | Date;
  expenseTypeCode: string | null;
  amount: string | number;
  reason: string;
  handlerUserId: string;
  projectCode: string | null;
  status: RequestStatus;
  approvalId: string | null;
  expenseRecordId: string | null;
  createdById: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface RawRow {
  id: string;
  request_date: string | Date;
  expense_type_code: string | null;
  amount: string | number;
  handler_user_id: string;
  project_code: string | null;
  reason: string;
  status: RequestStatus;
  expense_record_id: string | null;
}

export interface CreateRequestInput {
  readonly docType: RequestDocType;
  readonly requestDate?: string;
  readonly expenseTypeCode?: string;
  readonly amount: number;
  readonly reason?: string;
  readonly handlerUserId?: string;
  readonly projectCode?: string;
  readonly fileIds?: readonly string[];
}

export interface UpdateRequestInput {
  readonly requestDate?: string;
  readonly expenseTypeCode?: string | null;
  readonly amount?: number;
  readonly reason?: string;
  readonly handlerUserId?: string;
  readonly projectCode?: string | null;
  readonly fileIds?: readonly string[];
}

export interface RequestListQuery {
  readonly docType?: RequestDocType;
  readonly status?: RequestStatus;
  readonly expenseTypeCode?: string;
  readonly projectCode?: string;
  readonly from?: string;
  readonly to?: string;
  readonly mine?: boolean;
  /** 由端点注入的当前用户标识：mine=true 时只回本人的单。 */
  readonly mineOwnerId?: string;
  readonly page: number;
  readonly pageSize: number;
}

export interface PersonRef { readonly userId: string; readonly name: string; }

export interface FinanceRequestView {
  readonly id: string;
  readonly docType: RequestDocType;
  readonly docNo: string;
  readonly requestDate: string;
  readonly status: RequestStatus;
  readonly expenseTypeCode: string | null;
  readonly expenseTypeLabel: string | null;
  readonly amount: number;
  readonly reason: string;
  readonly handler: PersonRef;
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly approvalId: string | null;
  readonly expenseRecordId: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly files?: readonly DocFileView[];
}

export interface ConvertedRequest {
  readonly request: FinanceRequestView;
  readonly expenseRecordId: string;
}

export interface ApprovalFinalEvent {
  readonly approvalId: string;
  readonly collectionName: string;
  readonly dataKey: string;
  readonly status: 'approved' | 'rejected';
  readonly transactionHandle: unknown;
}

/** 服务到服务调用的审批授权：端点已对请款单动作授权，这里只补建单所需的库范围。 */
const INTERNAL_APPROVAL_POLICY: RepositoryPolicy = {
  read: true, create: true, update: true, delete: false,
};

const OWNER_TYPE: Readonly<Record<RequestDocType, string>> = {
  payment_request: 'payment_request',
  expense_claim: 'expense_claim',
};
const PREFIX: Readonly<Record<RequestDocType, string>> = {
  payment_request: CODE_PREFIXES.financePaymentRequest,
  expense_claim: CODE_PREFIXES.financeExpenseClaim,
};

const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? Number.NaN : Number(value);
const dayString = (value: string | Date): string => {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
};
const today = (): string => dayString(new Date());
const nullable = <T>(value: T | undefined): T | null => value ?? null;

export class FinanceRequestService {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly docFiles: DocFiles,
    private readonly approvals: ApprovalsService,
    private readonly finance: FinanceMutations,
    private readonly authz: AppAuthorization,
  ) {}

  private connection(): DatabaseConnection {
    return this.database.connection();
  }

  private async knex(tx?: DatabaseConnection): Promise<Knex> {
    return await (tx ?? this.connection()).client<Knex>();
  }

  private async findRow(
    connection: DatabaseConnection,
    id: string,
    policy?: RepositoryPolicy,
  ): Promise<RequestRow | undefined> {
    const repository = connection.repository<RequestRow>('financeRequestDocs');
    const row = policy === undefined
      ? await repository.findOne({ filter: { id } })
      : await repository.withPolicy(policy).findOne({ filter: { id } });
    return typeof row?.id === 'string' ? (row as RequestRow) : undefined;
  }

  private requireRow(row: RequestRow | undefined): RequestRow {
    if (row === undefined) fail('not-found');
    return row;
  }

  private requireView(view: FinanceRequestView | undefined): FinanceRequestView {
    if (view === undefined) fail('not-found');
    return view;
  }

  /** 先授权后读内容：绑定决策里的范围，不是本人的单与不存在同形。 */
  public async detail(id: string, policy?: RepositoryPolicy): Promise<FinanceRequestView | undefined> {
    const connection = this.connection();
    const row = await this.findRow(connection, id, policy);
    return row === undefined ? undefined : await this.viewOf(connection, row, true);
  }

  public async list(query: RequestListQuery, policy?: RepositoryPolicy): Promise<{
    items: FinanceRequestView[]; total: number; page: number; pageSize: number;
  }> {
    const connection = this.connection();
    const repository = connection.repository<RequestRow>('financeRequestDocs');
    const rows = (policy === undefined
      ? await repository.findMany()
      : await repository.withPolicy(policy).findMany()) as RequestRow[];
    const visible = rows.filter((row) => {
      if (query.docType !== undefined && row.docType !== query.docType) return false;
      if (query.status !== undefined && row.status !== query.status) return false;
      if (query.expenseTypeCode !== undefined && row.expenseTypeCode !== query.expenseTypeCode) return false;
      if (query.projectCode !== undefined && row.projectCode !== query.projectCode) return false;
      if (query.mine === true && row.createdById !== query.mineOwnerId) return false;
      const date = dayString(row.requestDate ?? new Date(0));
      if (query.from !== undefined && date < query.from) return false;
      if (query.to !== undefined && date > query.to) return false;
      return true;
    }).sort((left, right) => {
      const a = String(left.createdAt);
      const b = String(right.createdAt);
      return a === b ? String(left.id).localeCompare(String(right.id)) : b.localeCompare(a);
    });
    const start = (query.page - 1) * query.pageSize;
    const items = await Promise.all(
      visible.slice(start, start + query.pageSize).map((row) => this.viewOf(connection, row, false)),
    );
    return { items, total: visible.length, page: query.page, pageSize: query.pageSize };
  }

  public async create(input: CreateRequestInput, actor: { readonly id: string }): Promise<FinanceRequestView> {
    const knex = await this.knex();
    await this.checkAmount(input.amount);
    await this.checkPerson(knex, input.handlerUserId ?? actor.id);
    if (input.expenseTypeCode !== undefined) await this.checkDict('expense_type', input.expenseTypeCode);
    if (input.projectCode !== undefined) await this.checkDict('project', input.projectCode);

    const id = randomUUID();
    const now = new Date();
    await this.database.connection().transaction(async (tx) => {
      const txKnex = await this.knex(tx);
      await txKnex('finance_request_docs').insert({
        id,
        doc_type: input.docType,
        doc_no: await this.codes.nextCode(tx, PREFIX[input.docType]),
        request_date: input.requestDate ?? today(),
        expense_type_code: nullable(input.expenseTypeCode),
        amount: input.amount,
        reason: input.reason ?? '',
        handler_user_id: input.handlerUserId ?? actor.id,
        project_code: nullable(input.projectCode),
        status: 'draft',
        approval_id: null,
        expense_record_id: null,
        created_by_id: actor.id,
        created_at: now,
        updated_at: now,
      });
      await this.docFiles.bind(txKnex, OWNER_TYPE[input.docType], id, input.fileIds, actor.id);
    });
    return this.requireView(await this.detail(id));
  }

  public async update(
    id: string,
    input: UpdateRequestInput,
    actor: { readonly id: string },
    policy?: RepositoryPolicy,
  ): Promise<FinanceRequestView> {
    const row = this.requireRow(await this.findRow(this.connection(), id, policy));
    if (row.status !== 'draft' && row.status !== 'rejected') fail('not-editable', row.status);
    const knex = await this.knex();
    if (input.amount !== undefined) await this.checkAmount(input.amount);
    if (input.handlerUserId !== undefined) await this.checkPerson(knex, input.handlerUserId);
    if (input.expenseTypeCode !== undefined && input.expenseTypeCode !== null) {
      await this.checkDict('expense_type', input.expenseTypeCode);
    }
    if (input.projectCode !== undefined && input.projectCode !== null) {
      await this.checkDict('project', input.projectCode);
    }
    const values: Record<string, unknown> = { updated_at: new Date() };
    if (input.requestDate !== undefined) values.request_date = input.requestDate;
    if (input.expenseTypeCode !== undefined) values.expense_type_code = input.expenseTypeCode;
    if (input.amount !== undefined) values.amount = input.amount;
    if (input.reason !== undefined) values.reason = input.reason;
    if (input.handlerUserId !== undefined) values.handler_user_id = input.handlerUserId;
    if (input.projectCode !== undefined) values.project_code = input.projectCode;
    await this.database.connection().transaction(async (tx) => {
      const txKnex = await this.knex(tx);
      await txKnex('finance_request_docs').where('id', id).update(values);
      if (input.fileIds !== undefined) {
        await this.docFiles.bind(txKnex, OWNER_TYPE[row.docType], id, input.fileIds, actor.id);
      }
    });
    return this.requireView(await this.detail(id, policy));
  }

  public async submit(
    id: string,
    actor: { readonly id: string },
    policy?: RepositoryPolicy,
  ): Promise<FinanceRequestView> {
    const connection = this.connection();
    const row = this.requireRow(await this.findRow(connection, id, policy));
    if (row.status !== 'draft' && row.status !== 'rejected') fail('not-editable', row.status);
    const approvers = await this.resolveApprovers();
    if (approvers.length === 0) fail('approval-failed', 'no eligible finance approver');
    const snapshot = await this.snapshot(connection, row, approvers);

    try {
      await this.database.connection().transaction(async (tx) => {
        // 驳回是终态；重提开一张新审批单，approvalId 改指这一张，旧的留作审计。
        const approval = await this.approvals.create({
          collectionName: 'financeRequestDocs',
          dataKey: id,
          workflowKey: 'finance_request',
          data: snapshot,
          submit: true,
        }, actor, INTERNAL_APPROVAL_POLICY, tx);
        const updated = await (await this.knex(tx))('finance_request_docs')
          .where('id', id).whereIn('status', ['draft', 'rejected'])
          .update({ status: 'approving', approval_id: approval.id, updated_at: new Date() });
        if (updated === 0) fail('not-editable');
      });
    } catch (error) {
      if (error instanceof FinanceRequestRuleError) throw error;
      fail('approval-failed', error instanceof Error ? error.message : String(error));
    }
    return this.requireView(await this.detail(id, policy));
  }

  public async void(id: string, policy?: RepositoryPolicy): Promise<FinanceRequestView> {
    const row = this.requireRow(await this.findRow(this.connection(), id, policy));
    if (row.status !== 'draft') fail('not-editable', row.status);
    await (await this.knex())('finance_request_docs').where('id', id).where('status', 'draft')
      .update({ status: 'void', updated_at: new Date() });
    return this.requireView(await this.detail(id, policy));
  }

  public async convert(
    id: string,
    actor: { readonly id: string },
    policy?: RepositoryPolicy,
    connection?: DatabaseConnection,
  ): Promise<ConvertedRequest> {
    const row = this.requireRow(await this.findRow(this.connection(), id, policy));
    if (row.expenseRecordId !== null) fail('converted');
    if (row.status !== 'approved') fail('not-approved', row.status);

    const work = async (tx: DatabaseConnection): Promise<string> => {
      const txKnex = await this.knex(tx);
      const locked = await txKnex<RawRow>('finance_request_docs').where({ id }).forUpdate().first();
      if (locked === undefined) fail('not-found');
      if (locked.expense_record_id !== null) fail('converted');
      if (locked.status !== 'approved') fail('not-approved', locked.status);
      // 走 R-065 的建单服务与校验；同事务、草稿、不自动 confirm、附件不复制。
      const record = await this.finance.create('expense', {
        date: dayString(locked.request_date),
        bindMode: 'none',
        amount: num(locked.amount),
        typeCode: locked.expense_type_code,
        handlerUserId: locked.handler_user_id,
        projectCode: locked.project_code,
        remark: locked.reason,
        confirm: false,
      }, actor.id, tx);
      await txKnex('finance_request_docs').where({ id }).update({
        expense_record_id: record.id, status: 'converted', updated_at: new Date(),
      });
      return record.id;
    };

    const expenseRecordId = connection === undefined
      ? await this.database.connection().transaction(work)
      : await work(connection);
    return {
      request: this.requireView(await this.detail(id, policy)),
      expenseRecordId,
    };
  }

  /** lifecycle 在审批终态的转移事务里调用；审批单标识 + 当前状态保证只写一次。 */
  public async onApprovalFinal(event: ApprovalFinalEvent): Promise<void> {
    if (
      event.collectionName !== 'financeRequestDocs' ||
      (event.status !== 'approved' && event.status !== 'rejected')
    ) {
      return;
    }
    const knex = await this.knex(event.transactionHandle as DatabaseConnection);
    await knex('finance_request_docs')
      .where('id', event.dataKey)
      .where('approval_id', event.approvalId)
      .where('status', 'approving')
      .update({ status: event.status, updated_at: new Date() });
  }

  private async checkAmount(amount: number): Promise<void> {
    if (
      !Number.isFinite(amount) || amount <= 0 ||
      roundAmount(amount, 2) !== amount
    ) {
      fail('amount-invalid');
    }
  }

  private async checkPerson(knex: Knex, userId: string): Promise<void> {
    const row = await knex<{ user_id: string; status: string }>('employees')
      .select('status').where({ user_id: userId }).first();
    if (row === undefined || row.status !== 'active') fail('person-invalid', userId);
  }

  private async checkDict(dictType: string, code: string): Promise<void> {
    try {
      await assertActiveCodes(this.connection(), dictType, [code]);
    } catch {
      fail('dict-code-invalid', `${dictType}:${code}`);
    }
  }

  /** 候选人：持 finance 角色的在岗员工 + root；解析不到就拒绝提交，不自动通过。 */
  private async resolveApprovers(): Promise<readonly string[]> {
    const sets = this.authz.permissionSets;
    const ids = new Set<string>();
    for (const assignment of await sets.listAssignments('finance')) {
      if (assignment.subject.type === 'user') ids.add(assignment.subject.id);
    }
    for (const set of await sets.list()) {
      if (sets.protection(set.key)?.unrestricted !== true) continue;
      for (const assignment of await sets.listAssignments(set.key)) {
        if (assignment.subject.type === 'user') ids.add(assignment.subject.id);
      }
    }
    return [...(await activeIdsOf(this.connection(), [...ids]))];
  }

  /** 审批人只看到声明的窄列：没有电话、邮箱，也没有附件的 storageKey 与上传人。 */
  private async snapshot(
    connection: DatabaseConnection,
    row: RequestRow,
    approvers: readonly string[],
  ): Promise<Record<string, unknown>> {
    const view = await this.viewOf(connection, row, true);
    return {
      id: view.id,
      docType: view.docType,
      docNo: view.docNo,
      requestDate: view.requestDate,
      expenseTypeCode: view.expenseTypeCode,
      expenseTypeLabel: view.expenseTypeLabel,
      amount: view.amount,
      reason: view.reason,
      handler: view.handler,
      projectCode: view.projectCode,
      projectLabel: view.projectLabel,
      files: view.files ?? [],
      approvers: [...approvers],
    };
  }

  private async viewOf(
    connection: DatabaseConnection,
    row: RequestRow,
    withFiles: boolean,
  ): Promise<FinanceRequestView> {
    const knex = await this.knex(connection);
    const [handler, expenseType, project, files] = await Promise.all([
      knex<{ id: string; name: string | null }>('user')
        .select('id', 'name').where({ id: row.handlerUserId }).first(),
      row.expenseTypeCode === null
        ? Promise.resolve(undefined)
        : knex<{ name: string }>('biz_dict_entries')
          .select('name').where('dict_type', 'expense_type').where('code', row.expenseTypeCode).first(),
      row.projectCode === null
        ? Promise.resolve(undefined)
        : knex<{ name: string }>('biz_dict_entries')
          .select('name').where('dict_type', 'project').where('code', row.projectCode).first(),
      withFiles
        ? this.docFiles.filesOf(knex, OWNER_TYPE[row.docType], row.id)
        : Promise.resolve([] as DocFileView[]),
    ]);
    return {
      id: row.id,
      docType: row.docType,
      docNo: row.docNo,
      requestDate: dayString(row.requestDate),
      status: row.status,
      expenseTypeCode: row.expenseTypeCode,
      expenseTypeLabel: expenseType?.name ?? null,
      amount: num(row.amount),
      reason: row.reason,
      handler: { userId: row.handlerUserId, name: handler?.name ?? row.handlerUserId },
      projectCode: row.projectCode,
      projectLabel: project?.name ?? null,
      approvalId: row.approvalId,
      expenseRecordId: row.expenseRecordId,
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      ...(withFiles ? { files } : {}),
    };
  }
}

export const financeRequestsServiceToken: ServiceToken<FinanceRequestService> =
  createServiceToken<FinanceRequestService>('app/finance-requests-service');

export default class FinanceRequestsProvider extends ServiceProvider<Application> {
  public readonly name = 'app.finance-requests';

  public override register(): void {
    this.app.container.singleton(financeRequestsServiceToken, () =>
      new FinanceRequestService(
        this.app.container.resolve(databaseManagerToken),
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
        this.app.container.resolve(approvalsServiceToken),
        this.app.container.resolve(financeMutationsToken),
        this.app.container.resolve(authorizationToken),
      ),
    );
  }
}
