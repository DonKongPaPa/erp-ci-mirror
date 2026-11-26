import type { Application } from '@nocobase/app-server/application';
import type { Knex } from 'knex';
import { randomUUID } from 'node:crypto';

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

import {
  assertCodeAvailable,
  assertDeactivatable,
  assertDepartmentActive,
  assertKind,
  assertManagerIsMember,
  assertMemberRemovable,
  assertMergeable,
  assertNoCycle,
  assertParentActive,
  assertSuccessorActive,
  assertTitleAvailable,
  assertTransferable,
  DepartmentRuleError,
  type Department,
  type DepartmentMembership,
  type DepartmentRuleCode,
} from './departments.js';

/**
 * R-012 部门管理的写入服务。
 *
 * 合并与批量调动是端点编排不下的写操作，所以从这里走；其余写端点也放在这里，
 * 让「事务 + 咨询锁 + 规则校验 + 变动记录」只有一套实现。这些方法不进
 * `DepartmentService` 接口 —— 那个接口只给别的模块读（契约里只有七个读方法）。
 *
 * 并发照设计的「并发怎么挡」：
 * - 结构变更（改名、移动、启用、停用、合并）在事务开头取一把固定键的咨询锁，
 *   同一条链上的结构变更排队执行。SQLite 是单写者，跳过取锁。
 * - 设主部门靠 `departmentMembers` 上的部分唯一索引裁决；撞上就回滚，端点映射 409。
 * - 加成员以 `(departmentId, userId)` 的唯一约束为准，撞上当作跳过。
 * - 写校验用的快照与写入在同一个事务里读（走事务的仓储）。
 */

/** 部门表的完整一行（响应里要带时间戳与改组字段）。 */
export interface DepartmentRecord extends Department {
  readonly succeededAt: Date | string | null;
  readonly createdAt: Date | string;
  readonly updatedAt: Date | string;
}

/** 部门成员表的一行。 */
export interface DepartmentMembershipRecord extends DepartmentMembership {
  readonly createdAt: Date | string;
}

/** 成员变动记录的一行。只追加。 */
export interface DepartmentHistoryRecord {
  readonly id: string;
  readonly userId: string;
  readonly fromDepartmentId: string | null;
  readonly toDepartmentId: string | null;
  readonly isPrimary: boolean;
  readonly batchId: string;
  readonly actorId: string;
  readonly createdAt: Date | string;
}

export interface CreateDepartmentInput {
  readonly title: string;
  readonly code?: string;
  readonly kind?: string;
  readonly parentId?: string | null;
  readonly sortOrder?: number;
}

export interface UpdateDepartmentInput {
  readonly title?: string;
  readonly code?: string;
  readonly kind?: string;
  readonly parentId?: string | null;
  readonly sortOrder?: number;
  readonly managerId?: string | null;
}

export interface DeactivateDepartmentInput {
  readonly successorId?: string;
}

export interface TransferMembersInput {
  readonly userIds: readonly string[];
  readonly fromDepartmentId: string;
  readonly toDepartmentId: string;
}

/** 结构变更共用的咨询锁键。同一个库里的所有部门结构变更都排在这一把锁上。 */
const STRUCTURE_LOCK_KEY = 'hs-erp:departments:structure';

/** 一次写入涉及的三张表在一个事务里的快照。 */
interface Snapshot {
  readonly departments: readonly DepartmentRecord[];
  readonly memberships: readonly DepartmentMembershipRecord[];
}

interface HistoryEntry {
  readonly userId: string;
  readonly fromDepartmentId: string | null;
  readonly toDepartmentId: string | null;
  readonly isPrimary: boolean;
}

function ruleFail(code: DepartmentRuleCode): never {
  throw new DepartmentRuleError(code);
}

export class DatabaseDepartmentMutations {
  public constructor(private readonly database: DatabaseManager) {}

  /** 建部门。编码必填；同一上级下不重名、编码不在未撤销的部门之间重复。 */
  public async createDepartment(
    input: CreateDepartmentInput,
    transaction?: DatabaseConnection,
  ): Promise<DepartmentRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      // 建部门也是结构变更：取锁之后再读快照、重新校验重名与编码，两个并发建
      // 同名/同码的部门只有一个成功（Postgres 上排队；SQLite 单写者不需要）。
      await this.lockStructure(tx);
      const departments = await this.loadDepartments(tx);
      const title = input.title.trim();
      if (title === '') {
        return ruleFail('title-required');
      }
      const code = (input.code ?? '').trim();
      if (code === '') {
        return ruleFail('code-required');
      }
      const kind: string = input.kind ?? 'department';
      assertKind(kind);
      const parentId = input.parentId ?? null;
      if (
        parentId !== null &&
        !departments.some((department) => department.id === parentId)
      ) {
        return ruleFail('parent-not-found');
      }
      // 新建的部门未停用：上级已停用的部门不能再有未停用的子部门。
      assertParentActive(departments, parentId);
      assertTitleAvailable(departments, { title, parentId });
      assertCodeAvailable(departments, { code });

      const now = new Date();
      const { record } = await tx
        .repository<DepartmentRecord>('departments')
        .createOne({
          values: {
            id: randomUUID(),
            title,
            parentId,
            managerId: null,
            active: true,
            sortOrder: input.sortOrder ?? 0,
            kind,
            code,
            successorId: null,
            succeededAt: null,
            createdAt: now,
            updatedAt: now,
          },
        });
      return record;
    });
  }

  /**
   * 改名称、编码、类型、上级、排序、负责人。移动整个子树跟着走（只改父指针）。
   * 只改传进来的字段。
   */
  public async updateDepartment(
    departmentId: string,
    input: UpdateDepartmentInput,
    transaction?: DatabaseConnection,
  ): Promise<DepartmentRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const { departments, memberships } = await this.snapshot(tx);
      const current = departments.find(
        (department) => department.id === departmentId,
      );
      if (current === undefined) {
        return ruleFail('department-not-found');
      }

      const title =
        input.title === undefined ? current.title : input.title.trim();
      if (title === '') {
        return ruleFail('title-required');
      }
      const code = input.code === undefined ? current.code : input.code.trim();
      if (code === '') {
        return ruleFail('code-required');
      }
      const kind: string = input.kind ?? current.kind;
      assertKind(kind);
      const parentId =
        input.parentId === undefined ? current.parentId : input.parentId;
      if (parentId !== null) {
        if (!departments.some((department) => department.id === parentId)) {
          return ruleFail('parent-not-found');
        }
        // 未停用的部门不能挂到停用的部门下面；已停用的部门改上级不受这条约束。
        if (current.active) {
          assertParentActive(departments, parentId);
        }
        assertNoCycle(departments, departmentId, parentId);
      }
      if (title !== current.title || parentId !== current.parentId) {
        assertTitleAvailable(departments, {
          title,
          parentId,
          excludeId: departmentId,
        });
      }
      if (code !== current.code) {
        assertCodeAvailable(departments, { code, excludeId: departmentId });
      }
      if (input.managerId !== undefined) {
        assertManagerIsMember(memberships, departmentId, input.managerId);
      }

      const { record } = await tx
        .repository<DepartmentRecord>('departments')
        .updateOne({
          filter: { id: departmentId },
          values: {
            title,
            code,
            kind,
            parentId,
            ...(input.sortOrder === undefined
              ? {}
              : { sortOrder: input.sortOrder }),
            ...(input.managerId === undefined
              ? {}
              : { managerId: input.managerId }),
            updatedAt: new Date(),
          },
        });
      return record;
    });
  }

  /**
   * 停用。可以指定继任者；停用的部门一定是空的，继任者一定是未停用的部门。
   * 已经停用的部门再停用是幂等的：不报错，也不再改继任关系。
   */
  public async deactivateDepartment(
    departmentId: string,
    input: DeactivateDepartmentInput,
    transaction?: DatabaseConnection,
  ): Promise<DepartmentRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const { departments, memberships } = await this.snapshot(tx);
      const current = departments.find(
        (department) => department.id === departmentId,
      );
      if (current === undefined) {
        return ruleFail('department-not-found');
      }
      if (!current.active) {
        return current;
      }
      assertDeactivatable(departments, memberships, departmentId);
      const successorId = input.successorId ?? null;
      assertSuccessorActive(departments, departmentId, successorId);

      const now = new Date();
      const { record } = await tx
        .repository<DepartmentRecord>('departments')
        .updateOne({
          filter: { id: departmentId },
          values: {
            active: false,
            successorId,
            succeededAt: successorId === null ? null : now,
            updatedAt: now,
          },
        });
      return record;
    });
  }

  /** 启用。上级已停用的部门不能被启用（它会出现一个未停用的子部门）。 */
  public async activateDepartment(
    departmentId: string,
    transaction?: DatabaseConnection,
  ): Promise<DepartmentRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const { departments } = await this.snapshot(tx);
      const current = departments.find(
        (department) => department.id === departmentId,
      );
      if (current === undefined) {
        return ruleFail('department-not-found');
      }
      if (current.active) {
        return current;
      }
      if (current.parentId !== null) {
        const parent = departments.find(
          (department) => department.id === current.parentId,
        );
        if (parent === undefined || !parent.active) {
          return ruleFail('parent-deactivated');
        }
      }
      // 继任关系保留：它记的是历史（这个部门是怎么被并掉的），启用不改写历史。
      const { record } = await tx
        .repository<DepartmentRecord>('departments')
        .updateOne({
          filter: { id: departmentId },
          values: { active: true, updatedAt: new Date() },
        });
      return record;
    });
  }

  /**
   * 加成员。已经是成员的跳过、不报错也不重复；每个新增各写一行变动记录，
   * 同一次请求共用一个批次号。往停用的部门加成员被拒。
   */
  public async addMembers(
    departmentId: string,
    userIds: readonly string[],
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<{ readonly added: readonly string[]; readonly skipped: readonly string[] }> {
    return await this.inTransaction(transaction, async (tx) => {
      const { departments, memberships } = await this.snapshot(tx);
      if (!departments.some((department) => department.id === departmentId)) {
        return ruleFail('department-not-found');
      }
      assertDepartmentActive(departments, departmentId);

      const batchId = randomUUID();
      const now = new Date();
      const added: string[] = [];
      const skipped: string[] = [];
      for (const userId of [...new Set(userIds)]) {
        const exists = memberships.some(
          (membership) =>
            membership.departmentId === departmentId &&
            membership.userId === userId,
        );
        if (exists) {
          skipped.push(userId);
          continue;
        }
        try {
          // 嵌套事务在两种方言上都落成 savepoint：并发下另一请求刚插了这一行时，
          // 只回滚这一行，Postgres 的外层事务不会因此中止。
          await tx.transaction(async (row) => {
            await row
              .repository<DepartmentMembershipRecord>('departmentMembers')
              .createOne({
                values: {
                  id: randomUUID(),
                  departmentId,
                  userId,
                  isPrimary: false,
                  createdAt: now,
                },
              });
            await this.appendHistory(row, batchId, actorId, [
              {
                userId,
                fromDepartmentId: null,
                toDepartmentId: departmentId,
                isPrimary: false,
              },
            ]);
          });
        } catch (error) {
          // 并发下另一请求刚插了这一行：以唯一约束为准，当作跳过。
          if (isUniqueConstraintViolation(error)) {
            skipped.push(userId);
            continue;
          }
          throw error;
        }
        added.push(userId);
      }
      return { added, skipped };
    });
  }

  /**
   * 移出成员。负责人不能移出；要移出的是主部门而这个人在别的部门也待着时，
   * 先显式改主部门。移出留一行变动记录（toDepartmentId 为空）。
   */
  public async removeMember(
    departmentId: string,
    userId: string,
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<DepartmentMembershipRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      const { departments, memberships } = await this.snapshot(tx);
      const department = departments.find(
        (entry) => entry.id === departmentId,
      );
      if (department === undefined) {
        return ruleFail('department-not-found');
      }
      const membership = memberships.find(
        (entry) =>
          entry.departmentId === departmentId && entry.userId === userId,
      );
      if (membership === undefined) {
        return ruleFail('membership-not-found');
      }
      assertMemberRemovable(
        department,
        userId,
        memberships.filter((entry) => entry.userId === userId),
      );

      await tx
        .repository<DepartmentMembershipRecord>('departmentMembers')
        .deleteOne({ filter: { id: membership.id } });
      await this.appendHistory(tx, randomUUID(), actorId, [
        {
          userId,
          fromDepartmentId: departmentId,
          toDepartmentId: null,
          isPrimary: false,
        },
      ]);
      return membership;
    });
  }

  /**
   * R-011 离职用：一次调用把这个人从全部部门移出，共用一个批次号。
   *
   * 不循环调 `removeMember`：那是每次一个部门、每次各起一个批次号，一次离职会在
   * R-012 的记录里散成好几批。这里一个事务里删全部成员行、一次写全部变动记录。
   * 检测负责人时**不看部门是否停用**：停用的部门也可能留着负责人字段（改组历史），
   * 这种人同样不能直接移出。不在任何部门时是空操作，不写记录、批次号为空。
   */
  public async removeFromAllDepartments(
    userId: string,
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<{
    readonly batchId: string | null;
    readonly departmentIds: readonly string[];
  }> {
    return await this.inTransaction(transaction, async (tx) => {
      const { departments, memberships } = await this.snapshot(tx);
      if (departments.some((department) => department.managerId === userId)) {
        return ruleFail('manager-cannot-be-removed');
      }
      const mine = memberships.filter((membership) => membership.userId === userId);
      if (mine.length === 0) {
        return { batchId: null, departmentIds: [] };
      }
      const batchId = randomUUID();
      for (const membership of mine) {
        await tx
          .repository<DepartmentMembershipRecord>('departmentMembers')
          .deleteOne({ filter: { id: membership.id } });
      }
      await this.appendHistory(
        tx,
        batchId,
        actorId,
        mine.map((membership) => ({
          userId,
          fromDepartmentId: membership.departmentId,
          toDepartmentId: null,
          isPrimary: false,
        })),
      );
      return {
        batchId,
        departmentIds: mine.map((membership) => membership.departmentId).sort(),
      };
    });
  }

  /**
   * 设为这个用户的主部门。事务里先清旧的主部门、再设这一个；提交时撞上部分唯一
   * 索引说明另一个会话同时设了主部门 —— 让错误上抛，端点回滚并映射 409。
   * 本来就是主部门时不写变动记录。
   */
  public async setPrimaryDepartment(
    departmentId: string,
    userId: string,
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<DepartmentMembershipRecord> {
    return await this.inTransaction(transaction, async (tx) => {
      const { departments, memberships } = await this.snapshot(tx);
      if (!departments.some((department) => department.id === departmentId)) {
        return ruleFail('department-not-found');
      }
      const membership = memberships.find(
        (entry) =>
          entry.departmentId === departmentId && entry.userId === userId,
      );
      if (membership === undefined) {
        return ruleFail('membership-not-found');
      }
      const currentPrimary = memberships.find(
        (entry) => entry.userId === userId && entry.isPrimary,
      );
      if (currentPrimary?.id === membership.id) {
        return membership;
      }

      await tx.repository<DepartmentMembershipRecord>('departmentMembers').updateMany({
        filter: { userId, isPrimary: true },
        values: { isPrimary: false },
      });
      const { record } = await tx
        .repository<DepartmentMembershipRecord>('departmentMembers')
        .updateOne({
          filter: { id: membership.id },
          values: { isPrimary: true },
        });
      await this.appendHistory(tx, randomUUID(), actorId, [
        {
          userId,
          fromDepartmentId: currentPrimary?.departmentId ?? null,
          toDepartmentId: departmentId,
          isPrimary: true,
        },
      ]);
      return record;
    });
  }

  /**
   * 合并：原子的五步（预案「合并的规则」）。源部门的成员全部转到目标部门，
   * 已经在目标部门的只删源部门那一行；源行是主部门时目标部门那一行接任主部门。
   * 源部门负责人清空；源部门停用并记下继任者与时间；每个被移动的成员各写一行
   * 变动记录，共用一个批次号。
   */
  public async mergeDepartments(
    sourceId: string,
    targetId: string,
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<{
    readonly moved: number;
    readonly removed: number;
    readonly department: DepartmentRecord;
  }> {
    return await this.inTransaction(transaction, async (tx) => {
      await this.lockStructure(tx);
      const { departments, memberships } = await this.snapshot(tx);
      assertMergeable(departments, sourceId, targetId);

      const batchId = randomUUID();
      const sourceMembers = memberships.filter(
        (membership) => membership.departmentId === sourceId,
      );
      const targetUsers = new Set(
        memberships
          .filter((membership) => membership.departmentId === targetId)
          .map((membership) => membership.userId),
      );
      const history: HistoryEntry[] = [];
      let moved = 0;
      let removed = 0;
      for (const membership of sourceMembers) {
        const alreadyInTarget = targetUsers.has(membership.userId);
        if (alreadyInTarget) {
          await tx
            .repository<DepartmentMembershipRecord>('departmentMembers')
            .deleteOne({ filter: { id: membership.id } });
          // 源行是主部门：目标部门那一行接任主部门，不能让这个人没有主部门。
          // 主部门唯一由部分唯一索引保证：源行已经删掉，这一次设置不会撞。
          if (membership.isPrimary) {
            const targetMembership = memberships.find(
              (entry) =>
                entry.departmentId === targetId &&
                entry.userId === membership.userId,
            );
            if (targetMembership !== undefined) {
              await tx
                .repository<DepartmentMembershipRecord>('departmentMembers')
                .updateOne({
                  filter: { id: targetMembership.id },
                  values: { isPrimary: true },
                });
            }
          }
          removed += 1;
        } else {
          await tx
            .repository<DepartmentMembershipRecord>('departmentMembers')
            .updateOne({
              filter: { id: membership.id },
              values: { departmentId: targetId },
            });
          targetUsers.add(membership.userId);
          moved += 1;
        }
        history.push({
          userId: membership.userId,
          fromDepartmentId: sourceId,
          // 源行是主部门且目标行接任时，主部门的关系移到目标部门（to 为 target）；
          // 只是删掉源部门那一行的兼职关系时，视作移出（to 为空）。
          toDepartmentId:
            alreadyInTarget && !membership.isPrimary ? null : targetId,
          isPrimary: membership.isPrimary,
        });
      }
      await this.appendHistory(tx, batchId, actorId, history);

      const now = new Date();
      const { record } = await tx
        .repository<DepartmentRecord>('departments')
        .updateOne({
          filter: { id: sourceId },
          values: {
            managerId: null,
            active: false,
            successorId: targetId,
            succeededAt: now,
            updatedAt: now,
          },
        });
      return { moved, removed, department: record };
    });
  }

  /**
   * 批量调动：把一批人在源部门的成员关系换成目标部门，主部门的标记跟着走。
   * 已经在目标部门的只删源部门那一行。整批成功或整批不动（一个事务）。
   */
  public async transferMembers(
    input: TransferMembersInput,
    actorId: string,
    transaction?: DatabaseConnection,
  ): Promise<{ readonly moved: number; readonly removed: number }> {
    return await this.inTransaction(transaction, async (tx) => {
      const userIds = [...new Set(input.userIds)];
      if (
        userIds.length === 0 ||
        input.fromDepartmentId === '' ||
        input.toDepartmentId === '' ||
        input.fromDepartmentId === input.toDepartmentId
      ) {
        return ruleFail('transfer-invalid-request');
      }
      const { departments, memberships } = await this.snapshot(tx);
      assertTransferable(departments, memberships, {
        userIds,
        fromDepartmentId: input.fromDepartmentId,
        toDepartmentId: input.toDepartmentId,
      });

      const batchId = randomUUID();
      const history: HistoryEntry[] = [];
      let moved = 0;
      let removed = 0;
      for (const userId of userIds) {
        const source = memberships.find(
          (membership) =>
            membership.departmentId === input.fromDepartmentId &&
            membership.userId === userId,
        );
        if (source === undefined) {
          // 预检已经挡住；这里只是类型收窄。
          return ruleFail('transfer-user-not-member');
        }
        const alreadyInTarget = memberships.some(
          (membership) =>
            membership.departmentId === input.toDepartmentId &&
            membership.userId === userId,
        );
        if (alreadyInTarget) {
          await tx
            .repository<DepartmentMembershipRecord>('departmentMembers')
            .deleteOne({ filter: { id: source.id } });
          removed += 1;
        } else {
          await tx
            .repository<DepartmentMembershipRecord>('departmentMembers')
            .updateOne({
              filter: { id: source.id },
              values: { departmentId: input.toDepartmentId },
            });
          moved += 1;
        }
        history.push({
          userId,
          fromDepartmentId: input.fromDepartmentId,
          toDepartmentId: alreadyInTarget ? null : input.toDepartmentId,
          isPrimary: alreadyInTarget ? false : source.isPrimary,
        });
      }
      await this.appendHistory(tx, batchId, actorId, history);
      return { moved, removed };
    });
  }

  private async inTransaction<T>(
    transaction: DatabaseConnection | undefined,
    work: (tx: DatabaseConnection) => Promise<T>,
  ): Promise<T> {
    if (transaction !== undefined) {
      return await work(transaction);
    }
    return await this.database.transaction(work);
  }

  /**
   * 结构变更串行化。Postgres 用 `pg_advisory_xact_lock`，事务结束自动释放；
   * SQLite 是单写者，不需要取锁。键用固定的字符串哈希，所有部门结构变更共用。
   */
  private async lockStructure(tx: DatabaseConnection): Promise<void> {
    if (tx.dialect !== 'postgres') {
      return;
    }
    const knex = await tx.client<Knex>();
    await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [
      STRUCTURE_LOCK_KEY,
    ]);
  }

  private async snapshot(tx: DatabaseConnection): Promise<Snapshot> {
    // One transaction is one Postgres connection: concurrent queries on it are queued
    // with a deprecation warning and stop working in pg@9. Read the two tables in turn.
    const departments = await this.loadDepartments(tx);
    const memberships = await tx
      .repository<DepartmentMembershipRecord>('departmentMembers')
      .findMany();
    return { departments, memberships };
  }

  private async loadDepartments(
    tx: DatabaseConnection,
  ): Promise<DepartmentRecord[]> {
    return await tx.repository<DepartmentRecord>('departments').findMany();
  }

  private async appendHistory(
    tx: DatabaseConnection,
    batchId: string,
    actorId: string,
    entries: readonly HistoryEntry[],
  ): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    const now = new Date();
    const rows = entries.map((entry) => ({
      id: randomUUID(),
      userId: entry.userId,
      fromDepartmentId: entry.fromDepartmentId,
      toDepartmentId: entry.toDepartmentId,
      isPrimary: entry.isPrimary,
      batchId,
      actorId,
      createdAt: now,
    }));
    const [first, ...rest] = rows;
    const values: [typeof first, ...(typeof first)[]] = [first, ...rest];
    await tx
      .repository<DepartmentHistoryRecord>('departmentMemberHistory')
      .createMany({ values });
  }
}

export const departmentMutationsToken: ServiceToken<DatabaseDepartmentMutations> =
  createServiceToken<DatabaseDepartmentMutations>('app/department-mutations');

export default class DepartmentMutationsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.department-mutations';

  public override register(): void {
    this.app.container.singleton(departmentMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      return new DatabaseDepartmentMutations(database);
    });
  }
}
