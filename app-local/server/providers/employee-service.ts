import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';

import {
  departmentServiceToken,
  peopleQueryServiceToken,
  type DepartmentService,
  type PeopleQueryService,
} from './departments.js';

/**
 * R-011 的员工读服务与给别的模块用的内部服务。
 *
 * 所有对外形状都是逐列拼出来的：档案表只放组织事实，姓名、用户名现取共用搜人服务，
 * 部门名称现取部门读服务，岗位与职级名称现取字典表。邮箱、手机、证件号一律不读、不回。
 * 详情才带离职日期、上级姓名与兼职部门；列表没有这三列。
 */

/** 档案表的一行。列与迁移一致；不含任何联系人信息。 */
export interface EmployeeRecord {
  readonly id: string;
  readonly userId: string;
  readonly employeeNo: string;
  readonly positionId: string | null;
  readonly gradeId: string | null;
  readonly reportsToUserId: string | null;
  readonly hiredOn: string | Date;
  readonly leftOn: string | Date | null;
  readonly status: 'active' | 'left';
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

/** 变动记录的一行。只追加。 */
export interface EmployeeChangeRecord {
  readonly id: string;
  readonly userId: string;
  readonly kind: 'hired' | 'left' | 'rehired' | 'position' | 'grade' | 'reportsTo';
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly occurredOn: string | Date;
  readonly note: string | null;
  readonly actorId: string;
  readonly createdAt: string | Date;
}

/** 岗位与职级字典的一行。 */
export interface PositionRecord {
  readonly id: string;
  readonly title: string;
  readonly active: boolean;
  readonly sortOrder: number;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

export interface JobGradeRecord {
  readonly id: string;
  readonly title: string;
  readonly rank: number;
  readonly active: boolean;
  readonly createdAt: string | Date;
  readonly updatedAt: string | Date;
}

/** 列表的一行：八列加一个用于进详情的标识；没有邮箱、离职日期、上级、兼职部门。 */
export interface EmployeeListRow {
  readonly userId: string;
  readonly employeeNo: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly primaryDepartmentName: string | null;
  readonly positionName: string | null;
  readonly gradeName: string | null;
  readonly status: 'active' | 'left';
  readonly hiredOn: string | Date;
}

/** 详情：列表之外多出兼职部门、上级姓名与离职日期；上级只回姓名。 */
export interface EmployeeDetailRow extends EmployeeListRow {
  readonly secondaryDepartmentNames: readonly string[];
  readonly reportsToName: string | null;
  readonly leftOn: string | Date | null;
}

/** 变动记录只回操作人的姓名，不回他的用户名、工号或邮箱。 */
export interface EmployeeChangeView {
  readonly kind: EmployeeChangeRecord['kind'];
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly occurredOn: string | Date;
  readonly note: string | null;
  readonly actorName: string | null;
  readonly createdAt: string | Date;
}

/** 搜同事与内部 `search` 共同的五列。 */
export interface EmployeeCandidate {
  readonly userId: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly employeeNo: string;
  readonly primaryDepartmentName: string | null;
}

/** `displayByIds` 的五列；不含邮箱。 */
export interface EmployeeDisplay {
  readonly userId: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly employeeNo: string;
  readonly positionName: string | null;
}

/** 离职前检查：返回阻止离职的理由，没有理由就放行。 */
export type OffboardCheck = (
  userId: string,
  transaction: import('@nocobase/db').DatabaseConnection,
) => Promise<string | null>;

export interface EmployeeSearchOptions {
  readonly departmentIds?: readonly string[];
  readonly limit: number;
}

/**
 * 给别的模块用的内部服务（D:209-216）。六个方法的返回列都在这里写死：
 * 别的模块要对外搜人，自己开端点、自己定资格，只从这里取数。
 */
export interface EmployeeService {
  getByUserId(userId: string): Promise<EmployeeRecord | undefined>;
  isActive(userId: string): Promise<boolean>;
  displayByIds(
    userIds: readonly string[],
  ): Promise<Readonly<Record<string, EmployeeDisplay>>>;
  reportsTo(userId: string): Promise<string | null>;
  search(
    q: string,
    options: EmployeeSearchOptions,
  ): Promise<readonly EmployeeCandidate[]>;
  registerOffboardCheck(check: OffboardCheck): () => void;
}

/** HTTP 读端点共用的查询；列筛选逻辑只写这一处。 */
export interface EmployeeReader {
  list(query: {
    readonly page: number;
    readonly pageSize: number;
    readonly q?: string;
    readonly status?: 'active' | 'left';
    readonly departmentId?: string;
    readonly positionId?: string;
  }): Promise<{ readonly rows: readonly EmployeeListRow[]; readonly total: number }>;
  detail(userId: string): Promise<EmployeeDetailRow | undefined>;
  changes(userId: string): Promise<readonly EmployeeChangeView[]>;
  candidates(query: {
    readonly q: string;
    readonly departmentIds?: readonly string[];
    readonly page: number;
    readonly pageSize: number;
  }): Promise<{ readonly rows: readonly EmployeeCandidate[]; readonly total: number }>;
  positions(): Promise<readonly PositionRecord[]>;
  grades(): Promise<readonly JobGradeRecord[]>;
}

const compareNames = (left: EmployeeListRow, right: EmployeeListRow): number => {
  const a = left.name ?? left.username ?? '';
  const b = right.name ?? right.username ?? '';
  if (a !== b) {
    return a < b ? -1 : 1;
  }
  return left.employeeNo < right.employeeNo ? -1 : left.employeeNo > right.employeeNo ? 1 : 0;
};

export class DatabaseEmployeeReader implements EmployeeReader, EmployeeService {
  private readonly offboardChecks: OffboardCheck[] = [];

  public constructor(
    private readonly database: DatabaseManager,
    private readonly people: PeopleQueryService,
    private readonly departments: DepartmentService,
  ) {}

  public async list(query: {
    readonly page: number;
    readonly pageSize: number;
    readonly q?: string;
    readonly status?: 'active' | 'left';
    readonly departmentId?: string;
    readonly positionId?: string;
  }): Promise<{ readonly rows: readonly EmployeeListRow[]; readonly total: number }> {
    let rows = await this.database
      .repository<EmployeeRecord>('employees')
      .findMany();
    if (query.status !== undefined) {
      rows = rows.filter((row) => row.status === query.status);
    }
    if (query.positionId !== undefined) {
      rows = rows.filter((row) => row.positionId === query.positionId);
    }
    if (query.departmentId !== undefined) {
      const allowed = new Set(
        await this.departments.memberIdsOf(query.departmentId),
      );
      rows = rows.filter((row) => allowed.has(row.userId));
    }
    if (query.q !== undefined && query.q !== '') {
      const term = query.q.toLowerCase();
      const matched = await this.people.search({
        q: query.q,
        page: 1,
        pageSize: 10_000,
      });
      const byName = new Set(matched.rows.map((row) => row.id));
      rows = rows.filter(
        (row) =>
          byName.has(row.userId) || row.employeeNo.toLowerCase().includes(term),
      );
    }
    const views = [...(await this.toRows(rows))];
    views.sort(compareNames);
    const total = views.length;
    return {
      rows: views.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total,
    };
  }

  public async detail(userId: string): Promise<EmployeeDetailRow | undefined> {
    const profile = await this.database
      .repository<EmployeeRecord>('employees')
      .findOne({ filter: { userId } });
    if (profile === undefined) {
      return undefined;
    }
    const [row] = await this.toRows([profile]);
    if (row === undefined) {
      return undefined;
    }
    const [departmentIds, allUserIds] = await Promise.all([
      this.departments.departmentIdsOfUser(userId),
      this.database
        .repository<{ departmentId: string; userId: string }>('departmentMembers')
        .findMany({ filter: { userId } }),
    ]);
    const primaryId = await this.departments.primaryDepartmentOf(userId);
    const ids = [...new Set(allUserIds.map((entry) => entry.departmentId))];
    const titles = await this.departments.titlesByIds(ids);
    const supervisor =
      profile.reportsToUserId === null
        ? []
        : await this.people.byIds([profile.reportsToUserId]);
    return {
      ...row,
      secondaryDepartmentNames: departmentIds
        .filter((id) => id !== primaryId)
        .map((id) => titles[id])
        .filter((title): title is string => title !== undefined),
      reportsToName: supervisor[0]?.name ?? null,
      leftOn: profile.leftOn,
    };
  }

  public async changes(userId: string): Promise<readonly EmployeeChangeView[]> {
    const rows = await this.database
      .repository<EmployeeChangeRecord>('employeeChanges')
      .findMany({
        filter: { userId },
        sort: {
          kind: 'sort',
          version: 1,
          items: [
            { kind: 'field', path: ['createdAt'], direction: 'desc' },
            { kind: 'field', path: ['id'], direction: 'desc' },
          ],
        },
      });
    const actors = await this.people.byIds([
      ...new Set(rows.map((row) => row.actorId)),
    ]);
    const byId = new Map(actors.map((actor) => [actor.id, actor] as const));
    return rows.map((row) => ({
      kind: row.kind,
      fromValue: row.fromValue,
      toValue: row.toValue,
      occurredOn: row.occurredOn,
      note: row.note,
      actorName: byId.get(row.actorId)?.name ?? null,
      createdAt: row.createdAt,
    }));
  }

  public async candidates(query: {
    readonly q: string;
    readonly departmentIds?: readonly string[];
    readonly page: number;
    readonly pageSize: number;
  }): Promise<{ readonly rows: readonly EmployeeCandidate[]; readonly total: number }> {
    const all = [...(await this.searchActive(query.q, query.departmentIds))];
    all.sort((left, right) => {
      const a = left.name ?? left.username ?? '';
      const b = right.name ?? right.username ?? '';
      if (a !== b) {
        return a < b ? -1 : 1;
      }
      return left.userId < right.userId ? -1 : left.userId > right.userId ? 1 : 0;
    });
    return {
      rows: all.slice((query.page - 1) * query.pageSize, query.page * query.pageSize),
      total: all.length,
    };
  }

  public async positions(): Promise<readonly PositionRecord[]> {
    return await this.database.repository<PositionRecord>('positions').findMany();
  }

  public async grades(): Promise<readonly JobGradeRecord[]> {
    return await this.database.repository<JobGradeRecord>('jobGrades').findMany();
  }

  public async getByUserId(userId: string): Promise<EmployeeRecord | undefined> {
    return await this.database
      .repository<EmployeeRecord>('employees')
      .findOne({ filter: { userId } });
  }

  public async isActive(userId: string): Promise<boolean> {
    const profile = await this.getByUserId(userId);
    return profile?.status === 'active';
  }

  public async displayByIds(
    userIds: readonly string[],
  ): Promise<Readonly<Record<string, EmployeeDisplay>>> {
    if (userIds.length === 0) {
      return {};
    }
    const wanted = new Set(userIds);
    const profiles = (
      await this.database.repository<EmployeeRecord>('employees').findMany()
    ).filter((profile) => wanted.has(profile.userId));
    if (profiles.length === 0) {
      return {};
    }
    const [people, positions] = await Promise.all([
      this.people.byIds(profiles.map((profile) => profile.userId)),
      this.database.repository<PositionRecord>('positions').findMany(),
    ]);
    const peopleById = new Map(people.map((person) => [person.id, person] as const));
    const titles = new Map(positions.map((position) => [position.id, position.title] as const));
    const result: Record<string, EmployeeDisplay> = {};
    for (const profile of profiles) {
      const person = peopleById.get(profile.userId);
      // 账号不存在时这个标识不出现在结果里：调用方不会拿到只有工号的半行。
      if (person === undefined) {
        continue;
      }
      result[profile.userId] = {
        userId: profile.userId,
        name: person.name,
        username: person.username,
        employeeNo: profile.employeeNo,
        positionName:
          profile.positionId === null ? null : (titles.get(profile.positionId) ?? null),
      };
    }
    return result;
  }

  public async reportsTo(userId: string): Promise<string | null> {
    const profile = await this.getByUserId(userId);
    if (profile?.status !== 'active' || profile.reportsToUserId === null) {
      return null;
    }
    const manager = await this.getByUserId(profile.reportsToUserId);
    return manager?.status === 'active' ? manager.userId : null;
  }

  public async search(
    q: string,
    options: EmployeeSearchOptions,
  ): Promise<readonly EmployeeCandidate[]> {
    return await this.searchActive(q, options.departmentIds).then((rows) =>
      rows.slice(0, options.limit),
    );
  }

  public registerOffboardCheck(check: OffboardCheck): () => void {
    this.offboardChecks.push(check);
    return () => {
      const index = this.offboardChecks.indexOf(check);
      if (index >= 0) {
        this.offboardChecks.splice(index, 1);
      }
    };
  }

  /** 供写服务在离职事务里逐个询问；有理由就拒绝。 */
  public async offboardReasons(
    userId: string,
    transaction: import('@nocobase/db').DatabaseConnection,
  ): Promise<readonly string[]> {
    const reasons: string[] = [];
    for (const check of this.offboardChecks) {
      const reason = await check(userId, transaction);
      if (reason !== null && reason !== '') {
        reasons.push(reason);
      }
    }
    return reasons;
  }

  private async searchActive(
    q: string,
    departmentIds?: readonly string[],
  ): Promise<readonly EmployeeCandidate[]> {
    const term = q.toLowerCase();
    const [profiles, people] = await Promise.all([
      this.database.repository<EmployeeRecord>('employees').findMany({
        filter: { status: 'active' },
      }),
      this.people.search({ q, page: 1, pageSize: 10_000 }),
    ]);
    const matchedPeople = new Set(people.rows.map((person) => person.id));
    let candidates = profiles.filter(
      (profile) =>
        matchedPeople.has(profile.userId) ||
        profile.employeeNo.toLowerCase().includes(term),
    );
    if (departmentIds !== undefined) {
      const allowed = new Set<string>();
      for (const departmentId of departmentIds) {
        for (const userId of await this.departments.memberIdsOf(departmentId)) {
          allowed.add(userId);
        }
      }
      candidates = candidates.filter((profile) => allowed.has(profile.userId));
    }
    return await this.toCandidates(candidates);
  }

  private async toCandidates(
    profiles: readonly EmployeeRecord[],
  ): Promise<readonly EmployeeCandidate[]> {
    if (profiles.length === 0) {
      return [];
    }
    const [people, departments] = await Promise.all([
      this.people.byIds(profiles.map((profile) => profile.userId)),
      Promise.all(
        profiles.map(async (profile) => ({
          userId: profile.userId,
          departmentId: await this.departments.primaryDepartmentOf(profile.userId),
        })),
      ),
    ]);
    const peopleById = new Map(people.map((person) => [person.id, person] as const));
    const ids = [
      ...new Set(
        departments
          .map((entry) => entry.departmentId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const titles = await this.departments.titlesByIds(ids);
    return profiles.map((profile) => {
      const person = peopleById.get(profile.userId);
      const departmentId = departments.find(
        (entry) => entry.userId === profile.userId,
      )?.departmentId;
      return {
        userId: profile.userId,
        name: person?.name ?? null,
        username: person?.username ?? null,
        employeeNo: profile.employeeNo,
        primaryDepartmentName:
          departmentId === undefined || departmentId === null
            ? null
            : (titles[departmentId] ?? null),
      };
    });
  }

  private async toRows(
    profiles: readonly EmployeeRecord[],
  ): Promise<readonly EmployeeListRow[]> {
    if (profiles.length === 0) {
      return [];
    }
    const [people, positionNames, gradeNames, primaryIds] = await Promise.all([
      this.people.byIds(profiles.map((profile) => profile.userId)),
      this.repositoryTitles('positions'),
      this.repositoryTitles('jobGrades'),
      Promise.all(
        profiles.map(async (profile) => ({
          userId: profile.userId,
          departmentId: await this.departments.primaryDepartmentOf(profile.userId),
        })),
      ),
    ]);
    const peopleById = new Map(people.map((person) => [person.id, person] as const));
    const departmentIds = [
      ...new Set(
        primaryIds
          .map((entry) => entry.departmentId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const departmentNames = await this.departments.titlesByIds(departmentIds);
    return profiles.map((profile) => {
      const person = peopleById.get(profile.userId);
      const primaryId = primaryIds.find((entry) => entry.userId === profile.userId)
        ?.departmentId;
      return {
        userId: profile.userId,
        employeeNo: profile.employeeNo,
        name: person?.name ?? null,
        username: person?.username ?? null,
        primaryDepartmentName:
          primaryId === undefined || primaryId === null
            ? null
            : (departmentNames[primaryId] ?? null),
        positionName:
          profile.positionId === null
            ? null
            : (positionNames.get(profile.positionId) ?? null),
        gradeName:
          profile.gradeId === null ? null : (gradeNames.get(profile.gradeId) ?? null),
        status: profile.status,
        hiredOn: profile.hiredOn,
      };
    });
  }

  private async repositoryTitles(
    collection: 'positions' | 'jobGrades',
  ): Promise<Map<string, string>> {
    const rows = await this.database
      .repository<{ id: string; title: string }>(collection)
      .findMany();
    return new Map(rows.map((row) => [row.id, row.title] as const));
  }
}

export const employeeServiceToken: ServiceToken<DatabaseEmployeeReader> =
  createServiceToken<DatabaseEmployeeReader>('app/employees');

export const employeeReaderToken: ServiceToken<DatabaseEmployeeReader> =
  createServiceToken<DatabaseEmployeeReader>('app/employees-reader');

export default class EmployeesProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.employees';

  public override register(): void {
    this.app.container.singleton(employeeServiceToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const people = this.app.container.resolve(peopleQueryServiceToken);
      const departments = this.app.container.resolve(departmentServiceToken);
      return new DatabaseEmployeeReader(database, people, departments);
    });
    this.app.container.singleton(employeeReaderToken, () =>
      this.app.container.resolve(employeeServiceToken),
    );
  }
}
