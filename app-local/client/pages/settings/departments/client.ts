import type { ApiClient } from '@nocobase/app-client';

/** 部门的完整一行，字段与服务端的响应一致（R-012 的数据模型）。 */
export interface DepartmentRecord {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly kind: string;
  readonly code: string;
  readonly successorId: string | null;
  readonly succeededAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** `/departments/tree` 的节点：部门字段加子节点。 */
export interface DepartmentNode extends DepartmentRecord {
  readonly children: readonly DepartmentNode[];
}

/**
 * 搜人结果的三列。服务端只回这三列，不回邮箱（R-028 的选择性暴露）；
 * 用户行不存在时姓名与用户名是 `null`。
 */
export interface CandidateRow {
  readonly userId: string;
  readonly name: string | null;
  readonly username: string | null;
}

/** 成员行在搜人三列之外多一个「是不是主部门」：成员关系的事实，不是个人属性。 */
export interface MemberRow extends CandidateRow {
  readonly isPrimary: boolean;
}

export interface MemberPage {
  readonly items: readonly MemberRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface CandidatePage {
  readonly items: readonly CandidateRow[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface Membership {
  readonly id: string;
  readonly departmentId: string;
  readonly userId: string;
  readonly isPrimary: boolean;
  readonly createdAt: string;
}

export interface DepartmentInput {
  readonly title: string;
  readonly code: string;
  readonly kind: string;
  readonly parentId: string | null;
  readonly sortOrder: number;
  readonly managerId: string | null;
}

export interface AddMembersResult {
  readonly added: readonly string[];
  readonly skipped: readonly string[];
}

export interface MergeResult {
  readonly moved: number;
  readonly removed: number;
  readonly department: DepartmentRecord;
}

export interface TransferResult {
  readonly moved: number;
  readonly removed: number;
}

const pageOf = <T>(
  result: { data: readonly T[]; meta?: Record<string, unknown> },
  fallbackSize: number,
): { items: readonly T[]; total: number; page: number; pageSize: number } => ({
  items: result.data,
  total: (result.meta?.total as number) ?? 0,
  page: (result.meta?.page as number) ?? 1,
  pageSize: (result.meta?.pageSize as number) ?? fallbackSize,
});

/** R-012 维护页的接口客户端。写操作的幂等键不在这里：部门端点不要求。 */
export class DepartmentsClient {
  constructor(private readonly api: ApiClient) {}

  tree(): Promise<readonly DepartmentNode[]> {
    return this.api
      .request<{ data: readonly DepartmentNode[] }>({
        path: 'departments/tree',
      })
      .then(({ data }) => data);
  }

  members(
    departmentId: string,
    query: { page?: number; pageSize?: number } = {},
  ): Promise<MemberPage> {
    return this.api
      .request<{
        data: readonly MemberRow[];
        meta?: Record<string, unknown>;
      }>({
        path: `departments/${encodeURIComponent(departmentId)}/members`,
        query: Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined),
        ),
      })
      .then((result) => pageOf(result, 20));
  }

  candidates(query: {
    q: string;
    excludeDepartmentId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<CandidatePage> {
    return this.api
      .request<{
        data: readonly CandidateRow[];
        meta?: Record<string, unknown>;
      }>({
        path: 'departments/candidates',
        query: Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined),
        ),
      })
      .then((result) => pageOf(result, 20));
  }

  create(input: {
    title: string;
    code: string;
    kind: string;
    parentId?: string | null;
    sortOrder?: number;
  }): Promise<DepartmentRecord> {
    return this.api
      .request<{ data: DepartmentRecord }>({
        path: 'departments',
        method: 'POST',
        json: input,
      })
      .then(({ data }) => data);
  }

  update(
    departmentId: string,
    input: Partial<DepartmentInput>,
  ): Promise<DepartmentRecord> {
    return this.api
      .request<{ data: DepartmentRecord }>({
        path: `departments/${encodeURIComponent(departmentId)}`,
        method: 'PATCH',
        json: input,
      })
      .then(({ data }) => data);
  }

  deactivate(
    departmentId: string,
    successorId?: string | null,
  ): Promise<DepartmentRecord> {
    return this.api
      .request<{ data: DepartmentRecord }>({
        path: `departments/${encodeURIComponent(departmentId)}/deactivate`,
        method: 'POST',
        json: successorId ? { successorId } : {},
      })
      .then(({ data }) => data);
  }

  activate(departmentId: string): Promise<DepartmentRecord> {
    return this.api
      .request<{ data: DepartmentRecord }>({
        path: `departments/${encodeURIComponent(departmentId)}/activate`,
        method: 'POST',
        json: {},
      })
      .then(({ data }) => data);
  }

  merge(departmentId: string, targetId: string): Promise<MergeResult> {
    return this.api
      .request<{ data: MergeResult }>({
        path: `departments/${encodeURIComponent(departmentId)}/merge`,
        method: 'POST',
        json: { targetId },
      })
      .then(({ data }) => data);
  }

  addMembers(
    departmentId: string,
    userIds: readonly string[],
  ): Promise<AddMembersResult> {
    return this.api
      .request<{ data: AddMembersResult }>({
        path: `departments/${encodeURIComponent(departmentId)}/members`,
        method: 'POST',
        json: { userIds },
      })
      .then(({ data }) => data);
  }

  removeMember(departmentId: string, userId: string): Promise<Membership> {
    return this.api
      .request<{ data: Membership }>({
        path: `departments/${encodeURIComponent(departmentId)}/members/${encodeURIComponent(userId)}`,
        method: 'DELETE',
      })
      .then(({ data }) => data);
  }

  setPrimary(departmentId: string, userId: string): Promise<Membership> {
    return this.api
      .request<{ data: Membership }>({
        path: `departments/${encodeURIComponent(departmentId)}/members/${encodeURIComponent(userId)}/primary`,
        method: 'POST',
        json: {},
      })
      .then(({ data }) => data);
  }

  transfer(input: {
    userIds: readonly string[];
    fromDepartmentId: string;
    toDepartmentId: string;
  }): Promise<TransferResult> {
    return this.api
      .request<{ data: TransferResult }>({
        path: 'departments/members/transfer',
        method: 'POST',
        json: input,
      })
      .then(({ data }) => data);
  }
}
