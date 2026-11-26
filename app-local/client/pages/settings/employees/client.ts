import type { ApiClient } from '@nocobase/app-client';

/** 列表的一行：与 `EmployeeListRowSchema` 逐列对应，服务端不回邮箱。 */
export interface EmployeeRow {
  readonly userId: string;
  readonly employeeNo: string;
  readonly name: string | null;
  readonly username: string | null;
  readonly primaryDepartmentName: string | null;
  readonly positionName: string | null;
  readonly gradeName: string | null;
  readonly status: 'active' | 'left';
  readonly hiredOn: string;
}

/** 详情在列表八列之外多三列，同样不回邮箱。 */
export interface EmployeeDetail extends EmployeeRow {
  readonly secondaryDepartmentNames: readonly string[];
  readonly reportsToName: string | null;
  readonly leftOn: string | null;
}

/** 变动记录：操作人只回姓名。 */
export interface EmployeeChange {
  readonly kind: 'hired' | 'left' | 'rehired' | 'position' | 'grade' | 'reportsTo';
  readonly fromValue: string | null;
  readonly toValue: string | null;
  readonly occurredOn: string;
  readonly note: string | null;
  readonly actorName: string | null;
  readonly createdAt: string;
}

export interface PositionRow {
  readonly id: string;
  readonly title: string;
  readonly active: boolean;
  readonly sortOrder: number;
}

export interface JobGradeRow {
  readonly id: string;
  readonly title: string;
  readonly rank: number;
  readonly active: boolean;
}

export interface Page<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export type EmployeePage = Page<EmployeeRow>;

export interface HireInput {
  readonly name: string;
  readonly hiredOn: string;
  readonly username?: string;
  readonly password?: string;
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
  readonly positionId?: string | null;
  readonly gradeId?: string | null;
  readonly reportsToUserId?: string | null;
}

export interface LeaveInput {
  readonly leftOn: string;
  readonly note?: string;
}

export interface RehireInput {
  readonly hiredOn: string;
  readonly primaryDepartmentId?: string | null;
  readonly positionId?: string | null;
  readonly gradeId?: string | null;
  readonly reportsToUserId?: string | null;
}

export interface DictionaryInput {
  readonly id: string;
  readonly title: string;
  readonly sortOrder?: number;
  readonly rank?: number;
}

const pageOf = <T>(
  result: { data: readonly T[]; meta?: Record<string, unknown> },
  fallbackSize: number,
): Page<T> => ({
  items: result.data,
  total: (result.meta?.total as number) ?? 0,
  page: (result.meta?.page as number) ?? 1,
  pageSize: (result.meta?.pageSize as number) ?? fallbackSize,
});

function compact(query: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([name, value]) => [name, String(value)]),
  );
}

/** R-011 维护页的接口客户端。邮箱不进任何输入类型：入职的 email 由服务端按需生成。 */
export class EmployeesClient {
  constructor(private readonly api: ApiClient) {}

  list(query: { page?: number; pageSize?: number; q?: string; status?: 'active' | 'left' }): Promise<EmployeePage> {
    return this.api
      .request<{ data: readonly EmployeeRow[]; meta?: Record<string, unknown> }>({
        path: 'employees',
        query: compact({ ...query }),
      })
      .then((result) => pageOf(result, 20));
  }

  detail(userId: string): Promise<EmployeeDetail> {
    return this.api
      .request<{ data: EmployeeDetail }>({ path: `employees/${encodeURIComponent(userId)}` })
      .then(({ data }) => data);
  }

  changes(userId: string): Promise<readonly EmployeeChange[]> {
    return this.api
      .request<{ data: readonly EmployeeChange[] }>({
        path: `employees/${encodeURIComponent(userId)}/changes`,
      })
      .then(({ data }) => data);
  }

  hire(input: HireInput): Promise<EmployeeDetail> {
    return this.api
      .request<{ data: EmployeeDetail }>({ path: 'employees', method: 'POST', json: input })
      .then(({ data }) => data);
  }

  link(input: LinkInput): Promise<EmployeeDetail> {
    return this.api
      .request<{ data: EmployeeDetail }>({ path: 'employees/link', method: 'POST', json: input })
      .then(({ data }) => data);
  }

  update(userId: string, input: UpdateInput): Promise<EmployeeDetail> {
    return this.api
      .request<{ data: EmployeeDetail }>({
        path: `employees/${encodeURIComponent(userId)}`,
        method: 'PATCH',
        json: input,
      })
      .then(({ data }) => data);
  }

  leave(userId: string, input: LeaveInput): Promise<EmployeeDetail> {
    return this.api
      .request<{ data: EmployeeDetail }>({
        path: `employees/${encodeURIComponent(userId)}/leave`,
        method: 'POST',
        json: input,
      })
      .then(({ data }) => data);
  }

  rehire(userId: string, input: RehireInput): Promise<EmployeeDetail> {
    return this.api
      .request<{ data: EmployeeDetail }>({
        path: `employees/${encodeURIComponent(userId)}/rehire`,
        method: 'POST',
        json: input,
      })
      .then(({ data }) => data);
  }

  positions(): Promise<readonly PositionRow[]> {
    return this.api
      .request<{ data: readonly PositionRow[] }>({ path: 'positions' })
      .then(({ data }) => data);
  }

  createPosition(input: DictionaryInput): Promise<PositionRow> {
    return this.api
      .request<{ data: PositionRow }>({
        path: 'positions',
        method: 'POST',
        json: { id: input.id, title: input.title, ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }) },
      })
      .then(({ data }) => data);
  }

  updatePosition(id: string, input: { title?: string; sortOrder?: number; active?: boolean }): Promise<PositionRow> {
    return this.api
      .request<{ data: PositionRow }>({
        path: `positions/${encodeURIComponent(id)}`,
        method: 'PATCH',
        json: input,
      })
      .then(({ data }) => data);
  }

  grades(): Promise<readonly JobGradeRow[]> {
    return this.api
      .request<{ data: readonly JobGradeRow[] }>({ path: 'job-grades' })
      .then(({ data }) => data);
  }

  createGrade(input: DictionaryInput): Promise<JobGradeRow> {
    return this.api
      .request<{ data: JobGradeRow }>({
        path: 'job-grades',
        method: 'POST',
        json: { id: input.id, title: input.title, ...(input.rank === undefined ? {} : { rank: input.rank }) },
      })
      .then(({ data }) => data);
  }

  updateGrade(id: string, input: { title?: string; rank?: number; active?: boolean }): Promise<JobGradeRow> {
    return this.api
      .request<{ data: JobGradeRow }>({
        path: `job-grades/${encodeURIComponent(id)}`,
        method: 'PATCH',
        json: input,
      })
      .then(({ data }) => data);
  }
}
