import { randomBytes } from 'node:crypto';

import type { Application } from '@nocobase/app-server/application';
import {
  authorizationToken,
  type AppAuthorization,
} from '@nocobase/app-plugin-authorization/server';
import { userManagementServiceToken, type UserManagementService } from '@nocobase/app-plugin-users/server';
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
import type { Knex } from 'knex';

import { departmentMutationsToken, type DatabaseDepartmentMutations } from './department-mutations.js';
import {
  employeeServiceToken,
  type DatabaseEmployeeReader,
  type EmployeeChangeRecord,
  type EmployeeRecord,
  type JobGradeRecord,
  type PositionRecord,
} from './employee-service.js';

/**
 * R-011 员工写服务。入职、补档、调岗、离职、复聘各在自己的事务里；字典只停用不删除。
 *
 * 工号发号在事务开头取固定键咨询锁，读最大号加一；唯一约束再兜一层，撞上就整批重试
 * （线程内并发由咨询锁排队，SQLite 单写者靠唯一约束与重试）。账号只走用户管理服务的
 * `withConnection`：建、停、启与档案写在同一个事务里，回滚时账号行与会话行都不留。
 * 调岗、离职、复聘与字典停用共用一把固定键咨询锁，先取锁再校验，跨行不变量才有意义。
 */

/** 工号发号的咨询锁键，与部门结构锁分开。 */
const NUMBER_LOCK_KEY = 'hs-erp:employees:numbers';

/**
 * 员工结构变更的咨询锁键。为什么不按员工/字典 id 分键：不变量 3、4、6 都是跨行的 —— 两个
 * 事务各锁一方（A→B 与 B→A、离职者与新下属、岗位字典与用它的人），按单一实体 id 分键
 * 两边拿到的是不同的锁，校验仍会同时读到提交前快照。这里照部门结构锁与工号发号的先例，
 * 所有结构变更共用一把固定键的 `pg_advisory_xact_lock`，让校验与写入串行；事务结束自动释放。
 */
const STRUCTURE_LOCK_KEY = 'hs-erp:employees:structure';

/** 业务的「今天」按 Asia/Shanghai 取：UTC 的日期在 UTC+8 的 00:00–08:00 会落在前一天。 */
function businessToday(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string => parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export type EmployeeRuleCode =
  | 'target-user-not-found'
  | 'service-account'
  | 'profile-exists'
  | 'profile-not-found'
  | 'already-left'
  | 'not-left'
  | 'invalid-reference'
  | 'invalid-date'
  | 'invalid-update'
  | 'reports-to-self'
  | 'reports-to-cycle'
  | 'reports-to-not-active'
  | 'position-inactive'
  | 'grade-inactive'
  | 'position-in-use'
  | 'grade-in-use'
  | 'dictionary-exists'
  | 'dictionary-not-found'
  | 'self-leave'
  | 'is-department-manager'
  | 'has-direct-reports'
  | 'offboard-rejected'
  | 'account-protected'
  | 'employee-no-conflict'
  | 'employee-no-exhausted'
  | 'synthetic-email-reserved';

export class EmployeeRuleError extends Error {
  public constructor(
    readonly code: EmployeeRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Employee rule violated: ${code}`);
    this.name = 'EmployeeRuleError';
  }
}

function fail(code: EmployeeRuleCode, detail?: string): never {
  throw new EmployeeRuleError(code, detail);
}

/** 带资产引用更新的通用形状：`undefined` 是不动，`null` 是清空。 */
type ReferenceUpdate<T> = T | null;

export interface HireInput {
  readonly name: string;
  readonly username?: string;
  readonly email?: string;
  readonly password?: string;
  readonly hiredOn: string;
  readonly positionId?: string | null;
  readonly gradeId?: string | null;
  readonly reportsToUserId?: string | null;
  readonly primaryDepartmentId?: string | null;
}

export interface LinkInput {
  readonly userId: string;
  readonly hiredOn: string;
  readonly positionId?: string | null;
  readonly gradeId?: string | null;
  readonly reportsToUserId?: string | null;
  readonly primaryDepartmentId?: string | null;
}

export interface UpdateInput {
  readonly positionId?: ReferenceUpdate<string>;
  readonly gradeId?: ReferenceUpdate<string>;
  readonly reportsToUserId?: ReferenceUpdate<string>;
}

export interface LeaveInput {
  readonly leftOn: string;
  readonly note?: string;
}

export interface RehireInput {
  readonly hiredOn: string;
  readonly primaryDepartmentId?: string | null;
  readonly positionId?: ReferenceUpdate<string>;
  readonly gradeId?: ReferenceUpdate<string>;
  readonly reportsToUserId?: ReferenceUpdate<string>;
}

export interface DictionaryInput {
  readonly id: string;
  readonly title: string;
  readonly sortOrder?: number;
  readonly rank?: number;
}

export interface DictionaryUpdateInput {
  readonly title?: string;
  readonly sortOrder?: number;
  readonly rank?: number;
  readonly active?: boolean;
}

export class DatabaseEmployeeMutations {
  /**
   * 测试专用的失败点：在账号已建、档案未建之间抛错，用来证明两者同成一个事务。
   *
   * 生产上不可达，靠三件事保证：①请求体经 zod 校验，未知键被剥掉，外部调用方无法传
   * `setFailpointForTest`；②HTTP 路由只声明固定的端点，框架没有通用的服务方法调用入口；
   * ③源码里除下面这条测试接缝和验收测试外没有任何调用点。要触发它必须先有进程内代码
   * 执行能力，而那时系统已经被攻破。保留在类上是为让事务边界可以用真实服务验证。
   */
  private failpoint: 'after-account' | undefined;

  public setFailpointForTest(value: 'after-account' | undefined): void {
    this.failpoint = value;
  }

  public constructor(
    private readonly database: DatabaseManager,
    private readonly users: UserManagementService,
    private readonly departmentMutations: DatabaseDepartmentMutations,
    private readonly reader: DatabaseEmployeeReader,
    private readonly authz: Pick<AppAuthorization, 'permissionSets'>,
  ) {}

  /** 入职：号、账号、档案、入部门、hired 记录在同一个事务里。 */
  public async hire(input: HireInput, actorId: string): Promise<EmployeeRecord> {
    return await this.withNumberRetry(async (tx) => {
      await this.lockStructure(tx);
      await this.assertAssignment(input, tx);
      // 合成地址的域不能被显式邮箱占住，否则下一次不带邮箱的入职会永远撞同一个地址。
      if (input.email !== undefined && /^E\d{6}@staff\.invalid$/i.test(input.email)) {
        return fail('synthetic-email-reserved');
      }
      const employeeNo = await this.nextEmployeeNo(tx);
      // 没有邮箱用保留域名，没有口令用一段丢掉的随机串：在管理员重置前谁也登不进来。
      const email = input.email ?? `${employeeNo}@staff.invalid`;
      const password = input.password ?? `${randomBytes(24).toString('base64url')}Aa1!`;
      let created;
      try {
        created = await this.users.withConnection(tx).create({
          name: input.name,
          ...(input.username === undefined ? {} : { username: input.username }),
          email,
          password,
        });
      } catch (error) {
        this.rethrowUserError(error);
        throw error;
      }
      if (this.failpoint === 'after-account') {
        throw new Error('R011 test failpoint: account created, profile not yet');
      }
      const profile = await this.insertProfile(
        tx,
        {
          userId: created.id,
          employeeNo,
          positionId: input.positionId ?? null,
          gradeId: input.gradeId ?? null,
          reportsToUserId: input.reportsToUserId ?? null,
          hiredOn: input.hiredOn,
        },
        actorId,
        'hired',
      );
      await this.joinPrimaryDepartment(tx, created.id, input.primaryDepartmentId, actorId);
      return profile;
    });
  }

  /** 补档：账号必须已经存在；不新建账号，也不给服务账号建档。 */
  public async link(input: LinkInput, actorId: string): Promise<EmployeeRecord> {
    return await this.withNumberRetry(async (tx) => {
      await this.lockStructure(tx);
      await this.requirePerson(input.userId);
      const existing = await this.profile(tx, input.userId);
      if (existing !== undefined) {
        return fail('profile-exists');
      }
      await this.assertAssignment(input, tx);
      const employeeNo = await this.nextEmployeeNo(tx);
      const profile = await this.insertProfile(
        tx,
        {
          userId: input.userId,
          employeeNo,
          positionId: input.positionId ?? null,
          gradeId: input.gradeId ?? null,
          reportsToUserId: input.reportsToUserId ?? null,
          hiredOn: input.hiredOn,
        },
        actorId,
        'hired',
      );
      await this.joinPrimaryDepartment(tx, input.userId, input.primaryDepartmentId, actorId);
      return profile;
    });
  }

  /** 调岗、调级、换上级：每一项一行变动记录，整批一个事务。 */
  public async update(
    userId: string,
    input: UpdateInput,
    actorId: string,
  ): Promise<EmployeeRecord> {
    return await this.database.transaction(async (tx) => {
      await this.lockStructure(tx);
      const current = await this.requireActiveProfile(tx, userId);
      const fields = (['positionId', 'gradeId', 'reportsToUserId'] as const).filter(
        (key) => key in input,
      );
      if (fields.length === 0) {
        return fail('invalid-update');
      }
      const values: Record<string, string | null> = {};
      for (const key of fields) {
        const value = input[key];
        if (key === 'positionId') {
          if (value !== null && value !== undefined) await this.requirePosition(String(value), tx, true);
        } else if (key === 'gradeId') {
          if (value !== null && value !== undefined) await this.requireGrade(String(value), tx, true);
        } else if (value !== null && value !== undefined) {
          await this.requireReportsTo(userId, String(value), tx);
        }
        values[key] = value ?? null;
      }
      const { record } = await tx
        .repository<EmployeeRecord>('employees')
        .updateOne({ filter: { userId }, values: { ...values, updatedAt: new Date() } });
      for (const key of fields) {
        const before = current[key];
        const after = values[key];
        if (before === after) {
          continue;
        }
        await this.appendChange(tx, {
          userId,
          kind: key === 'positionId' ? 'position' : key === 'gradeId' ? 'grade' : 'reportsTo',
          fromValue: before,
          toValue: after,
          occurredOn: businessToday(),
          note: null,
          actorId,
        });
      }
      return record;
    });
  }

  /**
   * 离职：档案、R-012 的全部移出、left 记录、停用账号一个事务。
   *
   * `disable()` 内部的 `realtime.disconnectUser()` 是立即副作用、不随事务回滚，所以它是
   * 本事务最后一个应用写操作：它之后的任何步骤失败都不会让「已断连但还没提交」的窗口
   * 出现。提交本身失败属极端情形（见 R-011.md 的已知局限），接受。
   */
  public async leave(
    userId: string,
    input: LeaveInput,
    actorId: string,
  ): Promise<EmployeeRecord> {
    return await this.database.transaction(async (tx) => {
      await this.lockStructure(tx);
      const current = await this.requireActiveProfile(tx, userId);
      if (userId === actorId) {
        return fail('self-leave');
      }
      await this.assertNotProtected(userId, actorId);
      const departments = await tx.repository<{ id: string; managerId: string | null }>('departments').findMany();
      if (departments.some((department) => department.managerId === userId)) {
        return fail('is-department-manager');
      }
      const reports = await tx.repository<EmployeeRecord>('employees').findMany({
        filter: { reportsToUserId: userId, status: 'active' },
      });
      if (reports.length > 0) {
        return fail('has-direct-reports');
      }
      const reasons = await this.reader.offboardReasons(userId, tx);
      if (reasons.length > 0) {
        return fail('offboard-rejected', reasons.join('；'));
      }

      const { record } = await tx.repository<EmployeeRecord>('employees').updateOne({
        filter: { userId },
        values: { status: 'left', leftOn: input.leftOn, updatedAt: new Date() },
      });
      await this.departmentMutations.removeFromAllDepartments(userId, actorId, tx);
      await this.appendChange(tx, {
        userId,
        kind: 'left',
        fromValue: current.employeeNo,
        toValue: null,
        occurredOn: input.leftOn,
        note: input.note ?? null,
        actorId,
      });
      // 停用（连带实时断连）必须是最后一个写操作，后面只允许 return 与提交。
      try {
        await this.users.withConnection(tx).disable(userId, actorId);
      } catch (error) {
        this.rethrowUserError(error);
        throw error;
      }
      return record;
    });
  }

  /** 复聘：工号不变；未带的岗位、职级、上级沿用旧值，旧值停用就拒绝。 */
  public async rehire(
    userId: string,
    input: RehireInput,
    actorId: string,
  ): Promise<EmployeeRecord> {
    return await this.database.transaction(async (tx) => {
      await this.lockStructure(tx);
      const current = await this.profile(tx, userId);
      if (current === undefined) {
        return fail('profile-not-found');
      }
      if (current.status !== 'left') {
        return fail('not-left');
      }
      await this.requirePerson(userId);
      const positionId = await this.inheritedReference(
        current.positionId,
        input.positionId,
        'positionId',
        tx,
      );
      const gradeId = await this.inheritedReference(
        current.gradeId,
        input.gradeId,
        'gradeId',
        tx,
      );
      const reportsToUserId =
        input.reportsToUserId === undefined
          ? await this.reportsToForRehire(current, tx)
          : input.reportsToUserId;
      if (reportsToUserId !== null) {
        await this.requireReportsTo(userId, reportsToUserId, tx);
      }

      const { record } = await tx.repository<EmployeeRecord>('employees').updateOne({
        filter: { userId },
        values: {
          status: 'active',
          hiredOn: input.hiredOn,
          leftOn: null,
          positionId,
          gradeId,
          reportsToUserId,
          updatedAt: new Date(),
        },
      });
      try {
        await this.users.withConnection(tx).enable(userId, actorId);
      } catch (error) {
        this.rethrowUserError(error);
        throw error;
      }
      await this.joinPrimaryDepartment(tx, userId, input.primaryDepartmentId, actorId);
      const occurredOn = input.hiredOn;
      await this.appendChange(tx, {
        userId,
        kind: 'rehired',
        fromValue: current.employeeNo,
        toValue: null,
        occurredOn,
        note: null,
        actorId,
      });
      for (const [key, before, after] of [
        ['position', current.positionId, positionId],
        ['grade', current.gradeId, gradeId],
        ['reportsTo', current.reportsToUserId, reportsToUserId],
      ] as const) {
        if (before !== after) {
          await this.appendChange(tx, {
            userId,
            kind: key,
            fromValue: before,
            toValue: after,
            occurredOn,
            note: null,
            actorId,
          });
        }
      }
      return record;
    });
  }

  /** 岗位、职级字典：建与改（含停用、启用）；没有删除接口。 */
  public async createPosition(input: DictionaryInput): Promise<PositionRecord> {
    const now = new Date();
    const { record } = await this.database
      .repository<PositionRecord>('positions')
      .createOne({
        values: {
          id: input.id,
          title: input.title,
          active: true,
          sortOrder: input.sortOrder ?? 0,
          createdAt: now,
          updatedAt: now,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintViolation(error)) {
          return fail('dictionary-exists');
        }
        throw error;
      });
    return record;
  }

  public async updatePosition(id: string, input: DictionaryUpdateInput): Promise<PositionRecord> {
    return await this.database.transaction(async (tx) => {
      await this.lockStructure(tx);
      const row = await tx.repository<PositionRecord>('positions').findOne({ filter: { id } });
      if (row === undefined) {
        return fail('dictionary-not-found');
      }
      if (input.active === false) {
        const inUse = await tx.repository<EmployeeRecord>('employees').findMany({
          filter: { positionId: id, status: 'active' },
        });
        if (inUse.length > 0) {
          return fail('position-in-use');
        }
      }
      const { record } = await tx.repository<PositionRecord>('positions').updateOne({
        filter: { id },
        values: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
          ...(input.active === undefined ? {} : { active: input.active }),
          updatedAt: new Date(),
        },
      });
      return record;
    });
  }

  public async createGrade(input: DictionaryInput): Promise<JobGradeRecord> {
    const now = new Date();
    const { record } = await this.database
      .repository<JobGradeRecord>('jobGrades')
      .createOne({
        values: {
          id: input.id,
          title: input.title,
          rank: input.rank ?? 0,
          active: true,
          createdAt: now,
          updatedAt: now,
        },
      })
      .catch((error: unknown) => {
        if (isUniqueConstraintViolation(error)) {
          return fail('dictionary-exists');
        }
        throw error;
      });
    return record;
  }

  public async updateGrade(id: string, input: DictionaryUpdateInput): Promise<JobGradeRecord> {
    return await this.database.transaction(async (tx) => {
      await this.lockStructure(tx);
      const row = await tx.repository<JobGradeRecord>('jobGrades').findOne({ filter: { id } });
      if (row === undefined) {
        return fail('dictionary-not-found');
      }
      if (input.active === false) {
        const inUse = await tx.repository<EmployeeRecord>('employees').findMany({
          filter: { gradeId: id, status: 'active' },
        });
        if (inUse.length > 0) {
          return fail('grade-in-use');
        }
      }
      const { record } = await tx.repository<JobGradeRecord>('jobGrades').updateOne({
        filter: { id },
        values: {
          ...(input.title === undefined ? {} : { title: input.title }),
          ...(input.rank === undefined ? {} : { rank: input.rank }),
          ...(input.active === undefined ? {} : { active: input.active }),
          updatedAt: new Date(),
        },
      });
      return record;
    });
  }

  /** 工号撞唯一约束时整批重试：账号行也在同一个事务里，不会留下半个人。 */
  private async withNumberRetry<T>(work: (tx: DatabaseConnection) => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        return await this.database.transaction(work);
      } catch (error) {
        lastError = error;
        if (!isUniqueConstraintViolation(error)) {
          throw error;
        }
      }
    }
    throw new EmployeeRuleError('employee-no-conflict', String(lastError));
  }

  private async nextEmployeeNo(tx: DatabaseConnection): Promise<string> {
    await this.lockNumbers(tx);
    const rows = await tx.repository<EmployeeRecord>('employees').findMany({
      limit: 1,
      sort: {
        kind: 'sort',
        version: 1,
        items: [{ kind: 'field', path: ['employeeNo'], direction: 'desc' }],
      },
    });
    let max = 0;
    for (const row of rows) {
      const matched = /^E(\d{6})$/.exec(row.employeeNo);
      if (matched !== null) {
        max = Math.max(max, Number(matched[1]));
      }
    }
    // 六位序号用尽时明确拒绝：发出七位号会破坏工号格式，而且下次仍从同一个最大值
    // 加一，永远撞在唯一约束上，卡死整个入职流程。
    if (max >= 999_999) {
      return fail('employee-no-exhausted');
    }
    return `E${String(max + 1).padStart(6, '0')}`;
  }

  private async lockNumbers(tx: DatabaseConnection): Promise<void> {
    if (tx.dialect !== 'postgres') {
      return;
    }
    const knex = await tx.client<Knex>();
    await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [NUMBER_LOCK_KEY]);
  }

  /** 结构变更串行化：取锁在事务开头、任何校验读之前，第二个事务要等第一个提交后重新校。 */
  private async lockStructure(tx: DatabaseConnection): Promise<void> {
    if (tx.dialect !== 'postgres') {
      return;
    }
    const knex = await tx.client<Knex>();
    await knex.raw('SELECT pg_advisory_xact_lock(hashtext(?))', [STRUCTURE_LOCK_KEY]);
  }

  private async profile(
    tx: DatabaseConnection,
    userId: string,
  ): Promise<EmployeeRecord | undefined> {
    return await tx.repository<EmployeeRecord>('employees').findOne({ filter: { userId } });
  }

  private async requireActiveProfile(
    tx: DatabaseConnection,
    userId: string,
  ): Promise<EmployeeRecord> {
    const current = await this.profile(tx, userId);
    if (current === undefined) {
      return fail('profile-not-found');
    }
    if (current.status !== 'active') {
      return fail('already-left');
    }
    return current;
  }

  private async requirePerson(userId: string): Promise<void> {
    try {
      const user = await this.users.get(userId);
      if (user.kind === 'service') {
        return fail('service-account');
      }
    } catch (error) {
      if (error instanceof EmployeeRuleError) {
        throw error;
      }
      return fail('target-user-not-found');
    }
  }

  private async assertAssignment(
    input: {
      readonly positionId?: string | null;
      readonly gradeId?: string | null;
      readonly reportsToUserId?: string | null;
      readonly hiredOn: string;
    },
    tx: DatabaseConnection,
  ): Promise<void> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.hiredOn)) {
      return fail('invalid-date');
    }
    if (input.positionId !== undefined && input.positionId !== null) {
      await this.requirePosition(input.positionId, tx, true);
    }
    if (input.gradeId !== undefined && input.gradeId !== null) {
      await this.requireGrade(input.gradeId, tx, true);
    }
    if (input.reportsToUserId !== undefined && input.reportsToUserId !== null) {
      await this.requireReportsTo(null, input.reportsToUserId, tx);
    }
  }

  private async requirePosition(id: string, tx: DatabaseConnection, active: boolean): Promise<void> {
    const row = await tx.repository<PositionRecord>('positions').findOne({ filter: { id } });
    if (row === undefined || (active && !row.active)) {
      return fail('position-inactive');
    }
  }

  private async requireGrade(id: string, tx: DatabaseConnection, active: boolean): Promise<void> {
    const row = await tx.repository<JobGradeRecord>('jobGrades').findOne({ filter: { id } });
    if (row === undefined || (active && !row.active)) {
      return fail('grade-inactive');
    }
  }

  /** 上级是自己或沿上级链回到自己都是 409；上级离职或没档案是 422。 */
  private async requireReportsTo(
    userId: string | null,
    reportsToUserId: string,
    tx: DatabaseConnection,
  ): Promise<void> {
    if (userId === reportsToUserId) {
      return fail('reports-to-self');
    }
    let current: string | null = reportsToUserId;
    const visited = new Set<string>();
    while (current !== null) {
      if (current === userId || visited.has(current)) {
        return fail('reports-to-cycle');
      }
      visited.add(current);
      const profile = await this.profile(tx, current);
      if (profile?.status !== 'active') {
        return fail('reports-to-not-active');
      }
      current = profile.reportsToUserId;
    }
  }

  private async reportsToForRehire(
    current: EmployeeRecord,
    tx: DatabaseConnection,
  ): Promise<string | null> {
    if (current.reportsToUserId === null) {
      return null;
    }
    const manager = await this.profile(tx, current.reportsToUserId);
    if (manager?.status !== 'active') {
      return fail('reports-to-not-active');
    }
    return current.reportsToUserId;
  }

  private async inheritedReference(
    oldValue: string | null,
    supplied: ReferenceUpdate<string> | undefined,
    kind: 'positionId' | 'gradeId',
    tx: DatabaseConnection,
  ): Promise<string | null> {
    if (supplied !== undefined) {
      if (supplied === null) {
        return null;
      }
      if (kind === 'positionId') {
        await this.requirePosition(supplied, tx, true);
      } else {
        await this.requireGrade(supplied, tx, true);
      }
      return supplied;
    }
    if (oldValue === null) {
      return null;
    }
    if (kind === 'positionId') {
      await this.requirePosition(oldValue, tx, true);
    } else {
      await this.requireGrade(oldValue, tx, true);
    }
    return oldValue;
  }

  private async insertProfile(
    tx: DatabaseConnection,
    input: {
      readonly userId: string;
      readonly employeeNo: string;
      readonly positionId: string | null;
      readonly gradeId: string | null;
      readonly reportsToUserId: string | null;
      readonly hiredOn: string;
    },
    actorId: string,
    kind: 'hired',
  ): Promise<EmployeeRecord> {
    const now = new Date();
    const { record } = await tx.repository<EmployeeRecord>('employees').createOne({
      values: {
        id: randomBytes(16).toString('hex'),
        userId: input.userId,
        employeeNo: input.employeeNo,
        positionId: input.positionId,
        gradeId: input.gradeId,
        reportsToUserId: input.reportsToUserId,
        hiredOn: input.hiredOn,
        leftOn: null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
    await this.appendChange(tx, {
      userId: input.userId,
      kind,
      fromValue: null,
      toValue: input.employeeNo,
      occurredOn: input.hiredOn,
      note: null,
      actorId,
    });
    return record;
  }

  private async joinPrimaryDepartment(
    tx: DatabaseConnection,
    userId: string,
    departmentId: string | null | undefined,
    actorId: string,
  ): Promise<void> {
    if (departmentId === undefined || departmentId === null) {
      return;
    }
    await this.departmentMutations.addMembers(departmentId, [userId], actorId, tx);
    await this.departmentMutations.setPrimaryDepartment(departmentId, userId, actorId, tx);
  }

  private async appendChange(
    tx: DatabaseConnection,
    input: {
      readonly userId: string;
      readonly kind: EmployeeChangeRecord['kind'];
      readonly fromValue: string | null;
      readonly toValue: string | null;
      readonly occurredOn: string;
      readonly note: string | null;
      readonly actorId: string;
    },
  ): Promise<void> {
    await tx.repository<EmployeeChangeRecord>('employeeChanges').createOne({
      values: {
        id: randomBytes(16).toString('hex'),
        ...input,
        createdAt: new Date(),
      },
    });
  }

  /** root 只能动 root：赋权整表读出（带 permissionSet 筛选），本条自己查。 */
  private async assertNotProtected(userId: string, actorId: string): Promise<void> {
    const assignments = await this.authz.permissionSets.listAssignments('root');
    const roots = new Set(
      assignments
        .filter((assignment) => assignment.subject.type === 'user')
        .map((assignment) => assignment.subject.id),
    );
    if (roots.has(userId) && !roots.has(actorId)) {
      return fail('account-protected');
    }
  }

  /** 框架账号服务抛的是它自己的错误类；这里只重抛，让端点按域映射。 */
  private rethrowUserError(error: unknown): void {
    if (!(error instanceof Error)) {
      return;
    }
    if (
      error.name === 'UserManagementError' ||
      error.name === 'UserAdministrationError' ||
      error.name === 'UserRoleScopeError'
    ) {
      throw error;
    }
  }
}

export const employeeMutationsToken: ServiceToken<DatabaseEmployeeMutations> =
  createServiceToken<DatabaseEmployeeMutations>('app/employee-mutations');

export default class EmployeeMutationsProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.employee-mutations';

  public override register(): void {
    this.app.container.singleton(employeeMutationsToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const users = this.app.container.resolve(userManagementServiceToken);
      const departmentMutations = this.app.container.resolve(departmentMutationsToken);
      const reader = this.app.container.resolve(employeeServiceToken);
      const authz = this.app.container.resolve(authorizationToken);
      return new DatabaseEmployeeMutations(
        database,
        users,
        departmentMutations,
        reader,
        authz,
      );
    });
  }
}
