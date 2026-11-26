import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';

/**
 * R-012 部门管理的服务层。
 *
 * 两张表（departments / departmentMembers）的访问集中在这里：树的解析与环检测
 * 只有这一处实现，别的模块通过 departmentServiceToken 取接口，不直接查表。
 *
 * 校验规则写成操作内存快照的纯函数，端点在同一事务里先读快照、再调用它们：
 * - 部门构成一棵树：没有环
 * - 一个用户的主部门至多一个
 * - 停用的部门一定是空的
 * - 同一上级下名称不重名
 * - 负责人必须是本部门成员；负责人不能被移出
 * - 主部门不能直接移出：这个人还有别的部门时，先显式改主部门
 */

/** 部门类型。只是标记，树的规则不变。 */
export const DEPARTMENT_KINDS = [
  'company',
  'center',
  'department',
  'team',
] as const;

export type DepartmentKind = (typeof DEPARTMENT_KINDS)[number];

/**
 * 部门表的一行。字段照 R-012 的数据模型；时间戳与规则无关，不放进快照类型。
 * `code` 与 `successorId` 是第二部分加的改组字段。
 */
export interface Department {
  readonly id: string;
  readonly title: string;
  readonly parentId: string | null;
  readonly managerId: string | null;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly kind: DepartmentKind;
  readonly code: string;
  /** 被合并或撤销之后承接它的部门；没有继任者时为空。 */
  readonly successorId: string | null;
}

/** 部门成员表的一行。 */
export interface DepartmentMembership {
  readonly id: string;
  readonly departmentId: string;
  readonly userId: string;
  readonly isPrimary: boolean;
}

export type DepartmentRuleCode =
  | 'duplicate-title'
  | 'duplicate-code'
  | 'department-cycle'
  | 'multiple-primary-departments'
  | 'department-has-members'
  | 'department-has-active-children'
  | 'manager-not-member'
  | 'manager-cannot-be-removed'
  | 'primary-department-in-use'
  | 'department-deactivated'
  | 'parent-deactivated'
  | 'successor-deactivated'
  | 'invalid-department-kind'
  | 'merge-source-deactivated'
  | 'merge-source-has-active-children'
  | 'merge-target-self'
  | 'merge-target-deactivated'
  | 'merge-target-not-found'
  | 'merge-successor-cycle'
  | 'enable-merged-department'
  | 'transfer-user-not-member'
  | 'transfer-includes-manager'
  | 'transfer-target-not-found'
  | 'title-required'
  | 'code-required'
  | 'department-not-found'
  | 'membership-not-found'
  | 'parent-not-found'
  | 'transfer-invalid-request';

/** 规则被拒。端点按 code 映射状态码与提示，服务层不关心 HTTP。 */
export class DepartmentRuleError extends Error {
  public constructor(readonly code: DepartmentRuleCode) {
    super(`Department rule violated: ${code}`);
    this.name = 'DepartmentRuleError';
  }
}

function fail(code: DepartmentRuleCode): never {
  throw new DepartmentRuleError(code);
}

/**
 * 把 departmentId 挂到 newParentId 下不能成环，上级也不能是自己。
 *
 * 从 newParentId 沿 parentId 往上走；走回 departmentId 是环。遇到已访问节点
 * 说明现有数据本来就有环 —— 也拒绝，不把一棵坏树继续移动。
 */
export function assertNoCycle(
  departments: readonly Department[],
  departmentId: string,
  newParentId: string | null,
): void {
  if (newParentId === null) {
    return;
  }
  if (newParentId === departmentId) {
    fail('department-cycle');
  }
  const parents = new Map(
    departments.map((department) => [department.id, department.parentId]),
  );
  const visited = new Set<string>();
  let current: string | null = newParentId;
  while (current !== null) {
    if (current === departmentId || visited.has(current)) {
      fail('department-cycle');
    }
    visited.add(current);
    current = parents.get(current) ?? null;
  }
}

/**
 * 同一上级下名称不重名。根部门的 parentId 为空，数据库唯一约束盖不到，
 * 所以三种情况都走这里。停用的部门仍占着名字。
 */
export function assertTitleAvailable(
  departments: readonly Department[],
  input: {
    readonly title: string;
    readonly parentId: string | null;
    readonly excludeId?: string;
  },
): void {
  const clash = departments.some(
    (department) =>
      department.id !== input.excludeId &&
      department.parentId === input.parentId &&
      department.title === input.title,
  );
  if (clash) {
    fail('duplicate-title');
  }
}

/**
 * 一个用户的主部门至多一个。写主部门的流程要在同一事务里先清掉旧的主部门，
 * 再用这个函数核对落库后的快照。
 */
export function assertPrimaryInvariant(
  memberships: readonly DepartmentMembership[],
): void {
  const usersWithPrimary = new Set<string>();
  for (const membership of memberships) {
    if (!membership.isPrimary) {
      continue;
    }
    if (usersWithPrimary.has(membership.userId)) {
      fail('multiple-primary-departments');
    }
    usersWithPrimary.add(membership.userId);
  }
}

/** 停用的部门一定是空的：没有成员，也没有未停用的子部门。 */
export function assertDeactivatable(
  departments: readonly Department[],
  memberships: readonly DepartmentMembership[],
  departmentId: string,
): void {
  if (
    memberships.some((membership) => membership.departmentId === departmentId)
  ) {
    fail('department-has-members');
  }
  if (
    departments.some(
      (department) => department.parentId === departmentId && department.active,
    )
  ) {
    fail('department-has-active-children');
  }
}

/** 负责人必须是本部门的成员；不设这条会出现「负责人不在部门里」。 */
export function assertManagerIsMember(
  memberships: readonly DepartmentMembership[],
  departmentId: string,
  managerId: string | null,
): void {
  if (managerId === null) {
    return;
  }
  const isMember = memberships.some(
    (membership) =>
      membership.departmentId === departmentId &&
      membership.userId === managerId,
  );
  if (!isMember) {
    fail('manager-not-member');
  }
}

/**
 * 移出成员的两条拒绝：这个人是负责人；这是他的主部门而他还有别的部门。
 * userMemberships 是这个用户的全部成员关系（跨部门）。
 */
export function assertMemberRemovable(
  department: Department,
  userId: string,
  userMemberships: readonly DepartmentMembership[],
): void {
  if (department.managerId === userId) {
    fail('manager-cannot-be-removed');
  }
  const current = userMemberships.find(
    (membership) =>
      membership.departmentId === department.id && membership.userId === userId,
  );
  const hasOtherDepartment = userMemberships.some(
    (membership) =>
      membership.userId === userId && membership.departmentId !== department.id,
  );
  if (current?.isPrimary === true && hasOtherDepartment) {
    fail('primary-department-in-use');
  }
}

/**
 * 类型必须在这四种之内。`kind` 只是标记，但落库前要挡住拼错的值 ——
 * SQLite 不强制 enum，Postgres 的 enum 会直接拒绝，两边要在端点校验里给同一个答案。
 */
export function assertKind(kind: string): asserts kind is DepartmentKind {
  if (!(DEPARTMENT_KINDS as readonly string[]).includes(kind)) {
    fail('invalid-department-kind');
  }
}

/**
 * 编码在「还没有继任者的部门」之间唯一。已经指定了继任者的部门不再占用编码：
 * 它已经被并掉，编码留给承接方继续用。改名时用 excludeId 排除自己。
 */
export function assertCodeAvailable(
  departments: readonly Department[],
  input: { readonly code: string; readonly excludeId?: string },
): void {
  const clash = departments.some(
    (department) =>
      department.id !== input.excludeId &&
      department.successorId === null &&
      department.code === input.code,
  );
  if (clash) {
    fail('duplicate-code');
  }
}

/** 往停用的部门加成员、或把成员调动到停用的部门：停用的部门一定是空的。 */
export function assertDepartmentActive(
  departments: readonly Department[],
  departmentId: string,
): void {
  const department = departments.find((entry) => entry.id === departmentId);
  if (department === undefined || !department.active) {
    fail('department-deactivated');
  }
}

/**
 * 把一个未停用的部门挂到停用的部门下面会被拒；启用一个上级已经停用的部门同样。
 * 已经停用的部门改上级不受这条约束：它不会因此获得成员。
 */
export function assertParentActive(
  departments: readonly Department[],
  parentId: string | null,
): void {
  if (parentId === null) {
    return;
  }
  const parent = departments.find((department) => department.id === parentId);
  if (parent === undefined || !parent.active) {
    fail('parent-deactivated');
  }
}

/** 继任者在被指定的时候一定是未停用的部门，继任链也不能指回自己（不变量 5）。 */
export function assertSuccessorActive(
  departments: readonly Department[],
  departmentId: string,
  successorId: string | null,
): void {
  if (successorId === null) {
    return;
  }
  if (successorId === departmentId) {
    fail('successor-deactivated');
  }
  const successor = departments.find(
    (department) => department.id === successorId,
  );
  if (successor === undefined || !successor.active) {
    fail('successor-deactivated');
  }
  // 停用会把 departmentId.successorId 设成 successorId。继任者的链若已指回
  // departmentId，写下去就成环；与合并入口共用同一段整链校验。
  assertSuccessorNoCycle(departments, departmentId, successorId);
}

/**
 * 合并的预检，按预案「合并的规则」第 1 条与设计的状态码表：源部门不能已停用、
 * 不能有未停用的子部门；目标是源部门自己或已停用时被拒（这两种是 422）。
 * 成员的转移在事务里做，这里只看结构。
 */
export function assertMergeable(
  departments: readonly Department[],
  sourceId: string,
  targetId: string,
): void {
  if (targetId === sourceId) {
    fail('merge-target-self');
  }
  const target = departments.find((department) => department.id === targetId);
  if (target === undefined) {
    fail('merge-target-not-found');
  }
  if (!target.active) {
    fail('merge-target-deactivated');
  }
  const source = departments.find((department) => department.id === sourceId);
  if (source === undefined || !source.active) {
    fail('merge-source-deactivated');
  }
  if (
    departments.some(
      (department) => department.parentId === sourceId && department.active,
    )
  ) {
    fail('merge-source-has-active-children');
  }
  // 合并会给源部门写上 successorId = targetId；目标的继任链若已指回源，就成了环。
  assertSuccessorNoCycle(departments, sourceId, targetId);
}

/**
 * 目标的继任链不能指回源：否则合并后 source → target 与 target → … → source 成环，
 * 违反不变量 5（顺着继任关系一定走到未停用的部门）。合并入口与停用指定继任者
 * 共用这段校验；老数据里在用部门带着继任关系时同样会被挡住。
 * visited 同时挡住数据里已有的环，不在读法里兜底。
 */
function assertSuccessorNoCycle(
  departments: readonly Department[],
  sourceId: string,
  targetId: string,
): void {
  const byId = new Map(
    departments.map((department) => [department.id, department]),
  );
  const visited = new Set<string>();
  let current = byId.get(targetId)?.successorId ?? null;
  while (current !== null) {
    if (current === sourceId || visited.has(current)) {
      fail('merge-successor-cycle');
    }
    visited.add(current);
    current = byId.get(current)?.successorId ?? null;
  }
}

/**
 * 批量调动的预检：这批人必须都在源部门，且不能包含源部门的负责人；
 * 目标部门必须存在、未停用。整批拒绝，一个都不动。
 */
export function assertTransferable(
  departments: readonly Department[],
  memberships: readonly DepartmentMembership[],
  input: {
    readonly userIds: readonly string[];
    readonly fromDepartmentId: string;
    readonly toDepartmentId: string;
  },
): void {
  const target = departments.find(
    (department) => department.id === input.toDepartmentId,
  );
  if (target === undefined) {
    fail('transfer-target-not-found');
  }
  if (!target.active) {
    fail('department-deactivated');
  }
  for (const userId of input.userIds) {
    const member = memberships.some(
      (membership) =>
        membership.departmentId === input.fromDepartmentId &&
        membership.userId === userId,
    );
    if (!member) {
      fail('transfer-user-not-member');
    }
  }
  const source = departments.find(
    (department) => department.id === input.fromDepartmentId,
  );
  if (
    source?.managerId !== null &&
    source?.managerId !== undefined &&
    input.userIds.includes(source.managerId)
  ) {
    fail('transfer-includes-manager');
  }
}

/**
 * 给别的模块用的内部服务。R-013 的解析器依赖这个接口，不依赖具体的表。
 * 部门表还没数据、用户不属于任何部门时返回空集合或空值，不抛错。
 */
export interface DepartmentService {
  /** 这个部门与它全部未停用后代的 id；部门自己已停用就返回空。 */
  subtreeIds(departmentId: string): Promise<readonly string[]>;
  /** 这个人所属的全部未停用部门。 */
  departmentIdsOfUser(userId: string): Promise<readonly string[]>;
  /**
   * 某个未停用部门的成员账号 id。部门已停用或不存在时返回空数组
   * （R-011 验收15 前半）。给「按部门筛列表」与「搜同事限定在几个部门里」用。
   */
  memberIdsOf(departmentId: string): Promise<readonly string[]>;
  /** 负责人的用户 id，没有就返回空。 */
  managerOf(departmentId: string): Promise<string | null>;
  /** 主部门 id，没有就返回空。 */
  primaryDepartmentOf(userId: string): Promise<string | null>;
  /** id 到名称的对照。不存在的 id 不出现在结果里。 */
  titlesByIds(
    ids: readonly string[],
  ): Promise<Readonly<Record<string, string>>>;
  /**
   * 按编码找到的部门 id。同码且没撤销的优先；只找到已撤销的，就顺着继任关系
   * 给承接方；都没有返回空。
   */
  byCode(code: string): Promise<string | null>;
  /** 顺着继任关系走到头的部门 id；没有继任者返回空。 */
  resolveSuccessor(departmentId: string): Promise<string | null>;
}

export class DatabaseDepartmentService implements DepartmentService {
  public constructor(private readonly database: DatabaseManager) {}

  public async subtreeIds(departmentId: string): Promise<readonly string[]> {
    const departments = await this.loadDepartments();
    const byId = new Map(
      departments.map((department) => [department.id, department]),
    );
    // 部门自己已停用：整棵子树都不计入。
    if (byId.get(departmentId)?.active !== true) {
      return [];
    }

    const children = new Map<string, Department[]>();
    for (const department of departments) {
      if (department.parentId === null) {
        continue;
      }
      const siblings = children.get(department.parentId) ?? [];
      siblings.push(department);
      children.set(department.parentId, siblings);
    }

    // visited 同时挡住数据里误写的环；停用节点不再往下走。
    const visited = new Set<string>();
    const ids: string[] = [];
    const stack = [departmentId];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === undefined || visited.has(id)) {
        continue;
      }
      visited.add(id);
      if (byId.get(id)?.active !== true) {
        continue;
      }
      ids.push(id);
      for (const child of children.get(id) ?? []) {
        stack.push(child.id);
      }
    }
    return ids.sort();
  }

  public async departmentIdsOfUser(userId: string): Promise<readonly string[]> {
    const [departments, memberships] = await Promise.all([
      this.loadDepartments(),
      this.database
        .repository<DepartmentMembership>('departmentMembers')
        .findMany({ filter: { userId } }),
    ]);
    const active = new Set(
      departments
        .filter((department) => department.active)
        .map((department) => department.id),
    );
    return [
      ...new Set(
        memberships
          .map((membership) => membership.departmentId)
          .filter((departmentId) => active.has(departmentId)),
      ),
    ].sort();
  }

  public async memberIdsOf(departmentId: string): Promise<readonly string[]> {
    const department = await this.database
      .repository<Department>('departments')
      .findOne({ filter: { id: departmentId } });
    // 停用的部门一定是空的，不存在也一样：两种情况都不读成员表。
    if (department?.active !== true) {
      return [];
    }
    const memberships = await this.database
      .repository<DepartmentMembership>('departmentMembers')
      .findMany({ filter: { departmentId } });
    return [
      ...new Set(memberships.map((membership) => membership.userId)),
    ].sort();
  }

  public async managerOf(departmentId: string): Promise<string | null> {
    const department = await this.database
      .repository<Department>('departments')
      .findOne({ filter: { id: departmentId } });
    // 部门已停用：它的负责人不再算数。
    if (department?.active !== true) {
      return null;
    }
    return department.managerId ?? null;
  }

  public async primaryDepartmentOf(userId: string): Promise<string | null> {
    const membership = await this.database
      .repository<DepartmentMembership>('departmentMembers')
      .findOne({ filter: { userId, isPrimary: true } });
    if (membership === undefined) {
      return null;
    }
    const department = await this.database
      .repository<Department>('departments')
      .findOne({ filter: { id: membership.departmentId } });
    // 主部门已停用：返回空。
    return department?.active === true ? membership.departmentId : null;
  }

  public async titlesByIds(
    ids: readonly string[],
  ): Promise<Readonly<Record<string, string>>> {
    if (ids.length === 0) {
      return {};
    }
    const wanted = new Set(ids);
    const departments = await this.loadDepartments();
    return Object.fromEntries(
      departments
        .filter((department) => wanted.has(department.id))
        .map((department) => [department.id, department.title]),
    );
  }

  /** 整棵树一次读出；树的解析都在内存里做。 */
  private async loadDepartments(): Promise<Department[]> {
    return await this.database.repository<Department>('departments').findMany();
  }

  public async byCode(code: string): Promise<string | null> {
    const departments = await this.database
      .repository<DatedDepartment>('departments')
      .findMany();
    // 同码且没撤销的优先：它才是现在占用这个编码的部门。
    const live = departments.find(
      (department) =>
        department.code === code && department.successorId === null,
    );
    if (live !== undefined) {
      return live.id;
    }
    // 只找到已撤销的：取最晚停用的那个，再顺着继任关系给承接方。同码的已撤销部门
    // 可以不止一个（撤销之后编码让出来，别人可以接着用），按停用时间定一个确定的；
    // succeededAt 缺失（只可能来自手工改库）时回落到 updatedAt。
    const revoked = departments
      .filter(
        (department) =>
          department.code === code && department.successorId !== null,
      )
      .sort(compareRevokedByTime)[0];
    if (revoked === undefined) {
      return null;
    }
    return resolveSuccessorOf(departments, revoked.id);
  }

  public async resolveSuccessor(departmentId: string): Promise<string | null> {
    const departments = await this.loadDepartments();
    return resolveSuccessorOf(departments, departmentId);
  }
}

/** byCode 需要停用时间，规则函数不需要；只在读取时带上这两列。 */
interface DatedDepartment extends Department {
  readonly succeededAt: Date | string | null;
  readonly updatedAt: Date | string;
}

/** 停用时间；succeededAt 缺失时回落到 updatedAt。无法解析时按最早算。 */
function revokedTime(department: DatedDepartment): number {
  const value = department.succeededAt ?? department.updatedAt;
  const time =
    value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(time) ? time : 0;
}

/** 最晚停用的优先；时间相同按 id 排，保证每次结果一致。 */
function compareRevokedByTime(
  left: DatedDepartment,
  right: DatedDepartment,
): number {
  const diff = revokedTime(right) - revokedTime(left);
  if (diff !== 0) {
    return diff;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 顺着继任关系走到头。visited 挡住数据里误写的环（正常数据不会成环：继任者
 * 被指定时一定未停用）。没有继任者、或起点不存在时返回空。
 */
export function resolveSuccessorOf(
  departments: readonly Department[],
  departmentId: string,
): string | null {
  const byId = new Map(
    departments.map((department) => [department.id, department]),
  );
  if (!byId.has(departmentId)) {
    return null;
  }
  const visited = new Set<string>();
  let current = byId.get(departmentId)?.successorId ?? null;
  let last: string | null = null;
  while (current !== null && !visited.has(current)) {
    visited.add(current);
    last = current;
    current = byId.get(current)?.successorId ?? null;
  }
  return last;
}

/**
 * 搜人与取姓名共用的账号读服务（R-011「给别的模块用的内部服务」）。
 *
 * 原先这段直读用户的查询写在两个 R-012 端点里，现在收在这里，R-012 自己的两个端点、
 * R-017、R-003 走同一份口径。邮箱绝不在返回里（R-028 的选择性暴露）：匹配时不按邮箱，
 * 读取时也不取邮箱列。
 */

/** 三列账号视图；邮箱不在其中。 */
export interface PersonAccount {
  readonly id: string;
  readonly name: string | null;
  readonly username: string | null;
}

export interface PeopleQuery {
  /** 1 到 64 个字符，调用方（端点的 zod）已校验。 */
  readonly q: string;
  /** 只在这批账号里搜；缺省表示不限。 */
  readonly userIds?: readonly string[];
  /** 排除这批账号；缺省表示不排除。 */
  readonly excludeUserIds?: readonly string[];
  readonly page: number;
  readonly pageSize: number;
}

export interface PeopleQueryResult {
  readonly rows: readonly PersonAccount[];
  readonly total: number;
}

export interface PeopleQueryService {
  /**
   * 只按姓名、用户名不分大小写匹配，不按邮箱；停用与删除的账户不出现。
   * 只取三列，按姓名再按 id 排序，供端点分页。
   */
  search(query: PeopleQuery): Promise<PeopleQueryResult>;
  /**
   * 按一批标识取三列；不按账号状态过滤 —— 成员列表要给已停用的人显示姓名。
   * 空批次不发查询、返回空。
   */
  byIds(ids: readonly string[]): Promise<readonly PersonAccount[]>;
}

export class DatabasePeopleQueryService implements PeopleQueryService {
  public constructor(private readonly database: DatabaseManager) {}

  public async search(query: PeopleQuery): Promise<PeopleQueryResult> {
    const term = `%${query.q.toLowerCase()}%`;
    const db = this.database.connection().query;
    const build = () => {
      let select = db
        .selectFrom('user')
        .where('deletedAt', 'is', null)
        .where('disabledAt', 'is', null)
        .where((eb) =>
          eb.or([
            eb(eb.fn.lower('name'), 'like', term),
            eb(eb.fn.lower('username'), 'like', term),
          ]),
        );
      if (query.userIds !== undefined) {
        select = select.where('id', 'in', [...query.userIds]);
      }
      if (
        query.excludeUserIds !== undefined &&
        query.excludeUserIds.length > 0
      ) {
        select = select.where('id', 'not in', [...query.excludeUserIds]);
      }
      return select;
    };

    const [rows, totalRow] = await Promise.all([
      build()
        .select(['id', 'name', 'username'])
        .orderBy('name', 'asc')
        .orderBy('id', 'asc')
        .limit(query.pageSize)
        .offset((query.page - 1) * query.pageSize)
        .execute(),
      build()
        .select((eb) => [eb.fn.countAll<number>().as('total')])
        .executeTakeFirst<{ total: number }>(),
    ]);

    return {
      rows: rows.map((row) => ({
        id: String(row.id),
        name: typeof row.name === 'string' ? row.name : null,
        username: typeof row.username === 'string' ? row.username : null,
      })),
      total: Number(totalRow?.total ?? 0),
    };
  }

  public async byIds(
    ids: readonly string[],
  ): Promise<readonly PersonAccount[]> {
    if (ids.length === 0) {
      return [];
    }
    const rows = await this.database
      .connection()
      .query.selectFrom('user')
      .where('id', 'in', [...ids])
      .select(['id', 'name', 'username'])
      .execute();
    return rows.map((row) => ({
      id: String(row.id),
      name: typeof row.name === 'string' ? row.name : null,
      username: typeof row.username === 'string' ? row.username : null,
    }));
  }
}

export const departmentServiceToken: ServiceToken<DepartmentService> =
  createServiceToken<DepartmentService>('app/departments');

export const peopleQueryServiceToken: ServiceToken<PeopleQueryService> =
  createServiceToken<PeopleQueryService>('app/people-query');

export default class DepartmentProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.departments';

  public override register(): void {
    this.app.container.singleton(departmentServiceToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseDepartmentService(database);
    });
    this.app.container.singleton(peopleQueryServiceToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabasePeopleQueryService(database);
    });
  }
}
