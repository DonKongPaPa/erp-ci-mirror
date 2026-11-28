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
import { assertActiveCodes } from './biz-dict.js';
import { activeIdsOf } from '../active-users.js';
import { approvalsServiceToken, type ApprovalsService } from '../approvals-service.js';
import { CODE_PREFIXES, codeServiceToken, type CodeService } from './codes.js';
import { departmentServiceToken, type DepartmentService } from './departments.js';
import { docFilesToken, type DocFiles, type DocFileView } from './doc-files.js';
import { createApprovalReviewerResolver } from '../lifecycles/approvals-engine.js';
import type { Knex } from 'knex';

/**
 * R-021 波 1 加片：请购单的读服务与写服务。
 *
 * 只在两处接 R-017：submit 建审批单、审批终态由 lifecycle 在转移事务里回调写回。
 * 审批人按部门编码走 R-017 的部门选择器；解析不到就逐级上报，到顶仍无人则拒绝提交，
 * 绝不自动通过。预计单价只算请购单自己的合计，转出的采购订单价格一律留空。
 */
export type RequestStatus =
  | 'draft' | 'approving' | 'approved' | 'rejected' | 'void' | 'converted';

export type PurchaseRequestRuleCode =
  | 'not-found'
  | 'not-editable'
  | 'no-lines'
  | 'not-approved'
  | 'converted'
  | 'empty-patch'
  | 'line-invalid'
  | 'item-not-found'
  | 'item-inactive'
  | 'department-not-found'
  | 'department-inactive'
  | 'dict-code-invalid'
  | 'person-invalid'
  | 'approval-failed';

export class PurchaseRequestRuleError extends Error {
  public constructor(
    readonly code: PurchaseRequestRuleCode,
    readonly detail?: string,
  ) {
    super(
      detail === undefined
        ? `Purchase request rule violated: ${code}`
        : `Purchase request rule violated: ${code} (${detail})`,
    );
    this.name = 'PurchaseRequestRuleError';
  }
}

function fail(code: PurchaseRequestRuleCode, detail?: string): never {
  throw new PurchaseRequestRuleError(code, detail);
}

interface RequestRow {
  id: string;
  docNo: string;
  requestDate: string | Date;
  departmentId: string;
  requesterUserId: string;
  projectCode: string | null;
  customText1: string | null;
  customText2: string | null;
  description: string;
  status: RequestStatus;
  approvalId: string | null;
  convertedOrderId: string | null;
  totalQty: string | number | null;
  estimatedTotal: string | number | null;
  createdById: string;
  createdAt: string | Date;
  updatedAt: string | Date;
}

interface LineRow {
  id: string;
  request_id: string;
  item_id: string;
  qty: string | number;
  expected_price: string | number | null;
  expected_amount: string | number | null;
}

interface ItemRow {
  id: string;
  code: string;
  name: string;
  spec: string | null;
  unit_code: string;
}

export interface RequestLineInput {
  readonly itemId: string;
  readonly qty: number;
  readonly expectedPrice?: number | null;
}

export interface CreateRequestInput {
  readonly requestDate?: string;
  readonly departmentId: string;
  readonly requesterUserId?: string;
  readonly projectCode?: string;
  readonly customText1?: string;
  readonly customText2?: string;
  readonly description?: string;
  readonly fileIds?: readonly string[];
}

export interface UpdateRequestInput {
  readonly requestDate?: string;
  readonly departmentId?: string;
  readonly requesterUserId?: string;
  readonly projectCode?: string | null;
  readonly customText1?: string | null;
  readonly customText2?: string | null;
  readonly description?: string;
  readonly fileIds?: readonly string[];
}

export interface SetLinesInput {
  readonly lines: readonly RequestLineInput[];
  readonly replace?: boolean;
}

export interface RequestListQuery {
  readonly departmentId?: string;
  readonly requesterUserId?: string;
  readonly projectCode?: string;
  readonly status?: RequestStatus;
  readonly from?: string;
  readonly to?: string;
  readonly mine?: boolean;
  readonly page: number;
  readonly pageSize: number;
}

export interface RequestLineView {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly expectedPrice: number | null;
  readonly expectedAmount: number | null;
  readonly item: {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly spec: string | null;
    readonly unitCode: string;
  };
}

export interface PurchaseRequestView {
  readonly id: string;
  readonly docNo: string;
  readonly requestDate: string;
  readonly status: RequestStatus;
  readonly department: { readonly id: string; readonly name: string };
  readonly requester: { readonly userId: string; readonly name: string };
  readonly projectCode: string | null;
  readonly projectLabel: string | null;
  readonly customText1: string | null;
  readonly customText2: string | null;
  readonly description: string;
  readonly approvalId: string | null;
  readonly convertedOrderId: string | null;
  readonly totalQty: number | null;
  readonly estimatedTotal: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly lines: readonly RequestLineView[];
  readonly files: readonly DocFileView[];
}

export interface ConvertedOrder {
  readonly request: PurchaseRequestView;
  readonly purchaseOrderId: string;
}

export interface ApprovalFinalEvent {
  readonly approvalId: string;
  readonly collectionName: string;
  readonly dataKey: string;
  readonly status: 'approved' | 'rejected';
  readonly transactionHandle: unknown;
}

/** 服务到服务调用的审批授权：端点已对请购单动作授权，这里只补建单所需的库范围。 */
const INTERNAL_APPROVAL_POLICY: RepositoryPolicy = {
  read: true,
  create: true,
  update: true,
  delete: false,
};

const num = (value: string | number | null | undefined): number =>
  value === null || value === undefined ? Number.NaN : Number(value);
const round2 = (value: number): number => Math.round((value + Number.EPSILON) * 100) / 100;
const dayString = (value: string | Date): string => {
  if (typeof value === 'string') return value.slice(0, 10);
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(value);
};
const today = (): string => dayString(new Date());
const nullable = <T>(value: T | undefined): T | null => value ?? null;

export class PurchaseRequestService {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly codes: CodeService,
    private readonly docFiles: DocFiles,
    private readonly approvals: ApprovalsService,
    private readonly departments: DepartmentService,
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
    const repository = connection.repository<RequestRow>('purchaseRequests');
    const row = policy === undefined
      ? await repository.findOne({ filter: { id } })
      : await repository.withPolicy(policy).findOne({ filter: { id } });
    return typeof row?.id === 'string' ? (row as RequestRow) : undefined;
  }

  private requireRow(row: RequestRow | undefined): RequestRow {
    if (row === undefined) fail('not-found');
    return row;
  }

  private requireView(view: PurchaseRequestView | undefined): PurchaseRequestView {
    if (view === undefined) fail('not-found');
    return view;
  }

  /** 先授权后读内容：仓储绑上决策里的范围，别人的单与不存在的单都是同一个 404。 */
  public async detail(
    id: string,
    policy?: RepositoryPolicy,
  ): Promise<PurchaseRequestView | undefined> {
    const connection = this.connection();
    const row = await this.findRow(connection, id, policy);
    return row === undefined ? undefined : await this.viewOf(connection, row);
  }

  public async list(
    query: RequestListQuery,
    policy?: RepositoryPolicy,
  ): Promise<{ items: PurchaseRequestView[]; total: number; page: number; pageSize: number }> {
    const connection = this.connection();
    const repository = connection.repository<RequestRow>('purchaseRequests');
    const rows = (policy === undefined
      ? await repository.findMany()
      : await repository.withPolicy(policy).findMany()) as RequestRow[];
    const visible = rows.filter((row) => {
      if (query.departmentId !== undefined && row.departmentId !== query.departmentId) return false;
      if (query.requesterUserId !== undefined && row.requesterUserId !== query.requesterUserId) return false;
      if (query.projectCode !== undefined && row.projectCode !== query.projectCode) return false;
      if (query.status !== undefined && row.status !== query.status) return false;
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
      visible.slice(start, start + query.pageSize).map(
        (row) => this.viewOf(connection, row, false),
      ),
    );
    return { items, total: visible.length, page: query.page, pageSize: query.pageSize };
  }

  public async create(input: CreateRequestInput, actor: { readonly id: string }): Promise<PurchaseRequestView> {
    const knex = await this.knex();
    await this.checkDepartment(knex, input.departmentId);
    await this.checkPerson(knex, input.requesterUserId ?? actor.id);
    if (input.projectCode !== undefined && input.projectCode !== null) {
      await this.checkProject(input.projectCode);
    }
    const id = randomUUID();
    const now = new Date();
    await this.database.connection().transaction(async (tx) => {
      const txKnex = await this.knex(tx);
      await txKnex('purchase_requests').insert({
        id,
        doc_no: await this.codes.nextCode(tx, CODE_PREFIXES.purchaseRequest),
        request_date: input.requestDate ?? today(),
        department_id: input.departmentId,
        requester_user_id: input.requesterUserId ?? actor.id,
        project_code: nullable(input.projectCode),
        custom_text1: nullable(input.customText1),
        custom_text2: nullable(input.customText2),
        description: input.description ?? '',
        status: 'draft',
        approval_id: null,
        converted_order_id: null,
        total_qty: null,
        estimated_total: null,
        created_by_id: actor.id,
        created_at: now,
        updated_at: now,
      });
      await this.docFiles.bind(txKnex, 'purchase_request', id, input.fileIds, actor.id);
    });
    return this.requireView(await this.detail(id));
  }

  public async update(
    id: string,
    input: UpdateRequestInput,
    actor: { readonly id: string },
    policy?: RepositoryPolicy,
  ): Promise<PurchaseRequestView> {
    const row = this.requireRow(await this.findRow(this.connection(), id, policy));
    if (row.status !== 'draft' && row.status !== 'rejected') fail('not-editable', row.status);
    const knex = await this.knex();
    if (input.departmentId !== undefined) await this.checkDepartment(knex, input.departmentId);
    if (input.requesterUserId !== undefined) await this.checkPerson(knex, input.requesterUserId);
    if (input.projectCode !== undefined && input.projectCode !== null) {
      await this.checkProject(input.projectCode);
    }
    const values: Record<string, unknown> = { updated_at: new Date() };
    if (input.requestDate !== undefined) values.request_date = input.requestDate;
    if (input.departmentId !== undefined) values.department_id = input.departmentId;
    if (input.requesterUserId !== undefined) values.requester_user_id = input.requesterUserId;
    if (input.projectCode !== undefined) values.project_code = input.projectCode;
    if (input.customText1 !== undefined) values.custom_text1 = input.customText1;
    if (input.customText2 !== undefined) values.custom_text2 = input.customText2;
    if (input.description !== undefined) values.description = input.description;
    if (Object.keys(values).length === 1 && input.fileIds === undefined) fail('empty-patch');
    await this.database.connection().transaction(async (tx) => {
      await (await this.knex(tx))('purchase_requests').where('id', id).update(values);
      if (input.fileIds !== undefined) {
        await this.docFiles.bind(await this.knex(tx), 'purchase_request', id, input.fileIds, actor.id);
      }
    });
    return this.requireView(await this.detail(id, policy));
  }

  public async setLines(
    id: string,
    input: SetLinesInput,
    policy?: RepositoryPolicy,
  ): Promise<PurchaseRequestView> {
    const row = this.requireRow(await this.findRow(this.connection(), id, policy));
    if (row.status !== 'draft' && row.status !== 'rejected') fail('not-editable', row.status);
    if (input.lines.length === 0) fail('line-invalid');
    const knex = await this.knex();
    await this.checkItems(knex, input.lines);
    const existing = await knex<{ item_id: string }>('purchase_request_lines')
      .where('request_id', id).select('item_id');
    const combined = input.replace === false
      ? [...existing.map((line) => line.item_id), ...input.lines.map((line) => line.itemId)]
      : input.lines.map((line) => line.itemId);
    if (new Set(combined).size !== combined.length) fail('line-invalid');

    await this.database.connection().transaction(async (tx) => {
      const txKnex = await this.knex(tx);
      if (input.replace !== false) {
        await txKnex('purchase_request_lines').where('request_id', id).delete();
      }
      for (const line of input.lines) {
        const expectedAmount = line.expectedPrice === null || line.expectedPrice === undefined
          ? null
          : round2(line.qty * line.expectedPrice);
        await txKnex('purchase_request_lines').insert({
          id: randomUUID(),
          request_id: id,
          item_id: line.itemId,
          qty: line.qty,
          expected_price: line.expectedPrice ?? null,
          expected_amount: expectedAmount,
        });
      }
      const all = await txKnex<LineRow>('purchase_request_lines').where('request_id', id);
      const totalQty = all.reduce((sum, line) => sum + num(line.qty), 0);
      const priced = all.filter((line) => line.expected_price !== null && line.expected_price !== undefined);
      const estimatedTotal = priced.length === 0
        ? null
        : round2(priced.reduce((sum, line) => sum + num(line.expected_amount), 0));
      await txKnex('purchase_requests').where('id', id).update({
        total_qty: totalQty,
        estimated_total: estimatedTotal,
        updated_at: new Date(),
      });
    });
    return this.requireView(await this.detail(id, policy));
  }

  public async submit(
    id: string,
    actor: { readonly id: string },
    policy?: RepositoryPolicy,
  ): Promise<PurchaseRequestView> {
    const connection = this.connection();
    const row = this.requireRow(await this.findRow(connection, id, policy));
    if (row.status !== 'draft' && row.status !== 'rejected') fail('not-editable', row.status);
    const knex = await this.knex(connection);
    const lines = await knex<LineRow>('purchase_request_lines').where('request_id', id);
    if (lines.length === 0) fail('no-lines');

    const department = await knex<{ code: string }>('departments')
      .select('code').where('id', row.departmentId).first();
    if (department === undefined) fail('department-not-found', row.departmentId);
    const approvers = await this.resolveApprovers(connection, department.code, actor.id);
    // 这里只在连 root 都解析不到时走到；用内部原因码，不把部门编码露给用户。
    if (approvers.length === 0) fail('approval-failed', 'no-approver');

    const snapshot = await this.snapshot(connection, row, approvers);
    try {
      await this.database.connection().transaction(async (tx) => {
        // 驳回是终态，R-017 的 submit 只能从 draft/returned 进；重提开一张新审批单，
        // 旧的留在库里供审计，approvalId 改指这一张。
        const approval = await this.approvals.create({
          collectionName: 'purchaseRequests',
          dataKey: id,
          workflowKey: 'purchase_request',
          data: snapshot,
          submit: true,
        }, actor, INTERNAL_APPROVAL_POLICY, tx);
        const updated = await (await this.knex(tx))('purchase_requests')
          .where('id', id).whereIn('status', ['draft', 'rejected'])
          .update({ status: 'approving', approval_id: approval.id, updated_at: new Date() });
        if (updated === 0) fail('not-editable');
      });
    } catch (error) {
      if (error instanceof PurchaseRequestRuleError) throw error;
      fail('approval-failed', error instanceof Error ? error.message : String(error));
    }
    return this.requireView(await this.detail(id, policy));
  }

  public async void(
    id: string,
    policy?: RepositoryPolicy,
  ): Promise<PurchaseRequestView> {
    const row = this.requireRow(await this.findRow(this.connection(), id, policy));
    if (row.status !== 'draft' && row.status !== 'rejected') fail('not-editable', row.status);
    await (await this.knex())('purchase_requests').where('id', id).whereIn('status', ['draft', 'rejected'])
      .update({ status: 'void', updated_at: new Date() });
    return this.requireView(await this.detail(id, policy));
  }

  public async convert(
    id: string,
    actor: { readonly id: string },
    policy?: RepositoryPolicy,
  ): Promise<ConvertedOrder> {
    const row = this.requireRow(await this.findRow(this.connection(), id, policy));
    if (row.convertedOrderId !== null) fail('converted');
    if (row.status !== 'approved') fail('not-approved', row.status);
    const knex = await this.knex();
    const lines = await knex<LineRow>('purchase_request_lines').where('request_id', id).orderBy('id', 'asc');
    if (lines.length === 0) fail('no-lines');

    let orderId = '';
    await this.database.connection().transaction(async (tx) => {
      const txKnex = await this.knex(tx);
      const locked = await txKnex<{
        status: string; description: string;
        project_code: string | null; converted_order_id: string | null;
      }>('purchase_requests').where('id', id).forUpdate().first();
      if (locked === undefined) fail('not-found');
      if (locked.converted_order_id !== null) fail('converted');
      if (locked.status !== 'approved') fail('not-approved', locked.status);
      orderId = randomUUID();
      const now = new Date();
      await txKnex('purchase_orders').insert({
        id: orderId,
        order_no: await this.codes.nextCode(tx, CODE_PREFIXES.purchaseOrder),
        // 请购单没有供应商列；采购补上之后再按既有流程提交。
        supplier_id: '',
        order_date: today(),
        status: 'draft',
        remark: locked.description,
        created_by_id: actor.id,
        warehouse_id: null,
        project_code: locked.project_code,
        handler_user_id: actor.id,
        purchase_request_id: id,
        discount_amount: 0,
        total_qty: null,
        tax_included_total: null,
        tax_excluded_total: null,
        tax_total: null,
        payable_total: null,
        latest_delivery_date: null,
        created_at: now,
        updated_at: now,
      });
      for (const line of lines) {
        await txKnex('purchase_order_lines').insert({
          id: randomUUID(),
          order_id: orderId,
          item_id: line.item_id,
          qty: line.qty,
          // 预计单价是估算，不是询价结果：价格与金额列一律留空。
          price: null,
          received_qty: 0,
          tax_rate: null,
          tax_excluded_price: null,
          tax_excluded_amount: null,
          tax_amount: null,
          tax_included_amount: null,
          delivery_date: null,
          note: null,
        });
      }
      await txKnex('purchase_requests').where('id', id).update({
        converted_order_id: orderId, status: 'converted', updated_at: now,
      });
    });
    return { request: this.requireView(await this.detail(id, policy)), purchaseOrderId: orderId };
  }

  /** lifecycle 在审批终态的转移事务里调用；带审批单标识的条件更新保证只写一次。 */
  public async onApprovalFinal(event: ApprovalFinalEvent): Promise<void> {
    if (
      event.collectionName !== 'purchaseRequests' ||
      (event.status !== 'approved' && event.status !== 'rejected')
    ) {
      return;
    }
    const connection = event.transactionHandle as DatabaseConnection;
    const knex = await this.knex(connection);
    await knex('purchase_requests')
      .where('id', event.dataKey)
      .where('approval_id', event.approvalId)
      .where('status', 'approving')
      .update({ status: event.status, updated_at: new Date() });
  }

  private async checkDepartment(knex: Knex, departmentId: string): Promise<void> {
    const row = await knex<{ active: boolean }>('departments')
      .select('active').where('id', departmentId).first();
    if (row === undefined) fail('department-not-found', departmentId);
    if (row.active !== true) fail('department-inactive', departmentId);
  }

  private async checkPerson(knex: Knex, userId: string): Promise<void> {
    const row = await knex<{ user_id: string; status: string }>('employees')
      .select('status').where({ user_id: userId }).first();
    if (row === undefined || row.status !== 'active') fail('person-invalid', userId);
  }

  private async checkProject(code: string): Promise<void> {
    try {
      await assertActiveCodes(this.connection(), 'project', [code]);
    } catch (_error) {
      fail('dict-code-invalid', code);
    }
  }

  private async checkItems(knex: Knex, lines: readonly RequestLineInput[]): Promise<void> {
    for (const line of lines) {
      if (!Number.isFinite(line.qty) || line.qty <= 0 ||
          (line.expectedPrice !== undefined && line.expectedPrice !== null &&
            (!Number.isFinite(line.expectedPrice) || line.expectedPrice < 0))) {
        fail('line-invalid');
      }
      const row = await knex<{ id: string; status: string }>('items')
        .select('id', 'status').where({ id: line.itemId }).first();
      if (row === undefined) fail('item-not-found', line.itemId);
      if (row.status !== 'active') fail('item-inactive', line.itemId);
    }
  }

  /** R-021：部门与其上级都没有在职主管时，审批任务回落到 root（unrestricted 权限集的指派人）。 */
  private async rootApprovers(): Promise<readonly string[]> {
    const sets = this.authz.permissionSets;
    const ids = new Set<string>();
    for (const set of await sets.list()) {
      if (sets.protection(set.key)?.unrestricted !== true) continue;
      for (const assignment of await sets.listAssignments(set.key)) {
        if (assignment.subject.type === 'user') ids.add(assignment.subject.id);
      }
    }
    return [...(await activeIdsOf(this.connection(), [...ids]))];
  }

  /** 按部门编码走 R-017 的部门选择器；没有主管就逐级上报，到顶无人回落到 root。 */
  private async resolveApprovers(
    connection: DatabaseConnection,
    departmentCode: string,
    applicantId: string,
  ): Promise<readonly string[]> {
    const knex = await this.knex(connection);
    const resolver = createApprovalReviewerResolver({
      departmentByCode: async (code) => {
        const id = await this.departments.byCode(code);
        if (id === null) return null;
        const row = await knex<{ active: boolean }>('departments')
          .select('active').where('id', id).first();
        if (row?.active !== true) return null;
        return { id, managerId: await this.departments.managerOf(id) };
      },
      eligible: async (userId) => (await activeIdsOf(connection, [userId])).has(userId),
    });
    const found = await resolver(
      [{ group: 1, type: 'department', referenceId: departmentCode }],
      { scope: 'app', applicantId },
    );
    if (found.length > 0) return found;

    let departmentId = await this.departments.byCode(departmentCode);
    const seen = new Set<string>();
    while (departmentId !== null && !seen.has(departmentId)) {
      seen.add(departmentId);
      const row = await knex<{ parent_id: string | null }>('departments')
        .select('parent_id').where('id', departmentId).first();
      const parentId = row?.parent_id ?? null;
      if (parentId === null) break;
      departmentId = parentId;
      const manager = await this.departments.managerOf(parentId);
      if (manager !== null && (await activeIdsOf(connection, [manager])).has(manager)) {
        return [manager];
      }
    }
    // 整个部门链都没有主管，按 R-021 回落到 root；root 不是员工，不经过上面的 eligible 过滤。
    const roots = await this.rootApprovers();
    return roots.length > 0 ? roots : [];
  }

  /** 审批人只看到本节声明的窄列：没有电话、邮箱，没有附件的 storageKey 与上传人。 */
  private async snapshot(
    connection: DatabaseConnection,
    row: RequestRow,
    approvers: readonly string[],
  ): Promise<Record<string, unknown>> {
    const view = await this.viewOf(connection, row);
    return {
      id: view.id,
      docNo: view.docNo,
      requestDate: view.requestDate,
      department: view.department,
      requester: view.requester,
      projectCode: view.projectCode,
      projectLabel: view.projectLabel,
      customText1: view.customText1,
      customText2: view.customText2,
      description: view.description,
      totalQty: view.totalQty,
      estimatedTotal: view.estimatedTotal,
      lines: view.lines,
      files: view.files,
      approvers: [...approvers],
    };
  }

  private async viewOf(
    connection: DatabaseConnection,
    row: RequestRow,
    withLines = true,
  ): Promise<PurchaseRequestView> {
    const knex = await this.knex(connection);
    const [department, requester, dict, lineRows, files] = await Promise.all([
      knex<{ id: string; title: string }>('departments')
        .select('id', 'title').where({ id: row.departmentId }).first(),
      knex<{ id: string; name: string }>('user')
        .select('id', 'name').where({ id: row.requesterUserId }).first(),
      row.projectCode === null
        ? Promise.resolve(undefined)
        : knex<{ name: string }>('biz_dict_entries')
          .select('name').where('dict_type', 'project').where('code', row.projectCode).first(),
      withLines
        ? knex<LineRow>('purchase_request_lines').where('request_id', row.id).orderBy('id', 'asc')
        : Promise.resolve([] as LineRow[]),
      withLines
        ? this.docFiles.filesOf(knex, 'purchase_request', row.id)
        : Promise.resolve([] as DocFileView[]),
    ]);
    let lines: RequestLineView[] = [];
    if (lineRows.length > 0) {
      const itemIds = [...new Set(lineRows.map((line) => line.item_id))];
      const items = itemIds.length === 0
        ? []
        : await knex<ItemRow>('items')
          .select('id', 'code', 'name', 'spec', 'unit_code').whereIn('id', itemIds);
      const byId = new Map(items.map((item) => [item.id, item]));
      lines = lineRows.map((line) => {
        const item = byId.get(line.item_id);
        return {
          id: line.id,
          itemId: line.item_id,
          qty: num(line.qty),
          expectedPrice: line.expected_price === null ? null : num(line.expected_price),
          expectedAmount: line.expected_amount === null ? null : num(line.expected_amount),
          item: item === undefined
            ? { id: line.item_id, code: '', name: '', spec: null, unitCode: '' }
            : { id: item.id, code: item.code, name: item.name, spec: item.spec, unitCode: item.unit_code },
        };
      });
    }
    return {
      id: row.id,
      docNo: row.docNo,
      requestDate: dayString(row.requestDate),
      status: row.status,
      department: { id: row.departmentId, name: department?.title ?? '' },
      requester: { userId: row.requesterUserId, name: requester?.name ?? row.requesterUserId },
      projectCode: row.projectCode,
      projectLabel: dict?.name ?? null,
      customText1: row.customText1,
      customText2: row.customText2,
      description: row.description,
      approvalId: row.approvalId,
      convertedOrderId: row.convertedOrderId,
      totalQty: row.totalQty === null ? null : num(row.totalQty),
      estimatedTotal: row.estimatedTotal === null ? null : num(row.estimatedTotal),
      createdAt: String(row.createdAt),
      updatedAt: String(row.updatedAt),
      lines,
      files: [...files],
    };
  }
}

export const purchaseRequestsServiceToken: ServiceToken<PurchaseRequestService> =
  createServiceToken<PurchaseRequestService>('app/purchase-requests-service');

export default class PurchaseRequestsProvider extends ServiceProvider<Application> {
  public readonly name = 'app.purchase-requests';

  public override register(): void {
    this.app.container.singleton(purchaseRequestsServiceToken, () =>
      new PurchaseRequestService(
        this.app.container.resolve(databaseManagerToken),
        this.app.container.resolve(codeServiceToken),
        this.app.container.resolve(docFilesToken),
        this.app.container.resolve(approvalsServiceToken),
        this.app.container.resolve(departmentServiceToken),
        this.app.container.resolve(authorizationToken),
      ),
    );
  }
}
