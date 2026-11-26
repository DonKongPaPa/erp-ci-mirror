import {
  authenticationToken,
  type AuthEnv,
} from '@nocobase/app-plugin-authentication';
import {
  authorizationToken,
  type AuthorizationEnv,
} from '@nocobase/app-plugin-authorization/server';
import type { Application } from '@nocobase/app-server/application';
import {
  AuthorizationDeniedError,
  type CompositeResourceConditions,
  type AuthorizationDecision,
} from '@nocobase/authorization/core';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  listResponse,
  type AppApiRouteContribution,
  type ApiErrorStatus,
} from '@nocobase/app-server/router';
import {
  getRequestLocale,
  getRequestTranslator,
  type Translator,
} from '@nocobase/i18n/server';
import { Hono, type Context } from 'hono';

import {
  departmentApiError,
} from './departments.js';
import {
  CreateJobGradeBody,
  CreatePositionBody,
  EmployeeCandidateSchema,
  EmployeeChangeSchema,
  EmployeeCandidatesQuery,
  EmployeeDetailSchema,
  EmployeeListRowSchema,
  HireEmployeeBody,
  JobGradeSchema,
  LeaveEmployeeBody,
  LinkEmployeeBody,
  ListEmployeesQuery,
  PositionSchema,
  RehireEmployeeBody,
  UpdateEmployeeBody,
  UpdateJobGradeBody,
  UpdatePositionBody,
} from './schemas.js';
import {
  EmployeeRuleError,
  employeeMutationsToken,
  type EmployeeRuleCode,
} from '../providers/employees.js';
import {
  employeeReaderToken,
  type DatabaseEmployeeReader,
} from '../providers/employee-service.js';

type EmployeeAction = 'view' | 'manage';
type EmployeeContext = Context<AuthEnv & AuthorizationEnv>;
type EmployeeDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 规则码到状态。设计里 422 不在框架状态表，用 httpStatus 显式指定（R-012 的先例）。 */
const RULE_STATUS: Readonly<
  Record<EmployeeRuleCode, { readonly status: ApiErrorStatus; readonly httpStatus?: 422 }>
> = {
  'target-user-not-found': { status: 'NOT_FOUND' },
  'service-account': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'profile-exists': { status: 'ALREADY_EXISTS' },
  'profile-not-found': { status: 'NOT_FOUND' },
  'already-left': { status: 'ABORTED' },
  'not-left': { status: 'ABORTED' },
  'invalid-reference': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'invalid-date': { status: 'INVALID_ARGUMENT' },
  'invalid-update': { status: 'INVALID_ARGUMENT' },
  'reports-to-self': { status: 'ABORTED' },
  'reports-to-cycle': { status: 'ABORTED' },
  'reports-to-not-active': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'position-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'grade-inactive': { status: 'FAILED_PRECONDITION', httpStatus: 422 },
  'position-in-use': { status: 'ABORTED' },
  'grade-in-use': { status: 'ABORTED' },
  'dictionary-exists': { status: 'ALREADY_EXISTS' },
  'dictionary-not-found': { status: 'NOT_FOUND' },
  'self-leave': { status: 'ABORTED' },
  'is-department-manager': { status: 'ABORTED' },
  'has-direct-reports': { status: 'ABORTED' },
  'offboard-rejected': { status: 'ABORTED' },
  'account-protected': { status: 'PERMISSION_DENIED' },
  'employee-no-conflict': { status: 'ABORTED' },
  'employee-no-exhausted': { status: 'ABORTED' },
};

const unprocessableResponse = {
  description: 'The request violates an employee rule (422).',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiErrorBody' },
    },
  },
} as const;

function reasonOf(code: EmployeeRuleCode): string {
  return code.replaceAll('-', '_').toUpperCase();
}

/** 框架账号服务自己的错误类只按名字识别（不在应用依赖里直接导入它的类）。 */
function userError(error: unknown): ApiError | null {
  if (error === null || typeof error !== 'object') {
    return null;
  }
  const record = error as { name?: unknown; code?: unknown; message?: string };
  const name = typeof record.name === 'string' ? record.name : '';
  if (
    name !== 'UserManagementError' &&
    name !== 'UserAdministrationError' &&
    name !== 'UserRoleScopeError'
  ) {
    return null;
  }
  const code = typeof record.code === 'string' ? record.code : '';
  const status: ApiErrorStatus = code.includes('CONFLICT')
    ? 'ALREADY_EXISTS'
    : code === 'USER_NOT_FOUND' || code === 'ROLE_SCOPE_NOT_FOUND'
      ? 'NOT_FOUND'
      : 'INVALID_ARGUMENT';
  return new ApiError({
    status,
    reason: code || 'ACCOUNT_ACTION_FAILED',
    domain: 'users',
    message: record.message ?? 'The account action failed.',
    cause: error,
  });
}

/** 所有写错误的统一出口：规则、部门规则、账号服务与并发冲突都在这里变成标准错误体。 */
function employeeApiError(
  error: unknown,
  translate: Translator,
  locale: string,
): ApiError {
  if (error instanceof EmployeeRuleError) {
    const rule = RULE_STATUS[error.code];
    const message = translate(`employees.errors.${error.code}`, {
      reason: error.detail ?? '',
      defaultValue: error.message,
    });
    return new ApiError({
      status: rule.status,
      reason: reasonOf(error.code),
      domain: 'employees',
      message: error.message,
      localizedMessage: { locale, message },
      metadata: error.detail === undefined ? undefined : { reason: error.detail },
      ...(rule.httpStatus === undefined ? {} : { httpStatus: rule.httpStatus }),
      cause: error,
    });
  }
  const department = departmentApiError(error);
  if (department !== null) {
    return department;
  }
  const account = userError(error);
  if (account !== null) {
    return account;
  }
  throw error;
}

async function authorizeEmployees(
  context: EmployeeContext,
  action: EmployeeAction,
): Promise<EmployeeDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'employees' },
    action,
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

/** 动账号还要框架的账号动作；`*` 对着全部账号，端点级的授权在开事务之前做完。 */
async function requireAccountActions(
  context: EmployeeContext,
  ...actions: readonly ('create' | 'assign-role' | 'disable' | 'enable')[]
): Promise<void> {
  for (const action of actions) {
    await context.get('authz').require({ resource: { type: 'user', id: '*' }, action });
  }
}

/** 带主部门的三个写操作还要 R-012 的「管理部门」，不能绕过管理员对改组的安排。 */
async function requireDepartmentManage(context: EmployeeContext): Promise<void> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'departments' },
    action: 'manage',
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
}

function actorOf(context: EmployeeContext): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'employees',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

function missingProfile(): ApiError {
  return new ApiError({
    status: 'NOT_FOUND',
    reason: 'EMPLOYEE_NOT_FOUND',
    domain: 'employees',
    message: 'The employee profile was not found.',
  });
}

const withMappedErrors = async <T>(
  context: EmployeeContext,
  work: () => Promise<T>,
): Promise<T> => {
  try {
    return await work();
  } catch (error) {
    throw employeeApiError(
      error,
      getRequestTranslator(context),
      getRequestLocale(context) ?? 'zh-CN',
    );
  }
};

/**
 * R-011 的 HTTP 端点。
 *
 * 读要 `employees.view`，写要 `employees.manage`；动账号的三个操作还要框架的账号动作，
 * 带主部门的三个操作还要 R-012 的 `departments.manage`。写端点的 Origin 校验由
 * `auth.required()` 负责。所有响应逐列拼装，任何端点都不回邮箱。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const reader: DatabaseEmployeeReader = app.container.resolve(employeeReaderToken);
    const mutations = app.container.resolve(employeeMutationsToken);

    for (const base of ['/employees', '/employees/*', '/positions', '/positions/*', '/job-grades', '/job-grades/*']) {
      router.use(base, auth.required(), authz.middleware());
    }

    const detailOf = async (userId: string) => {
      const row = await reader.detail(userId);
      if (row === undefined) {
        throw missingProfile();
      }
      return row;
    };

    router.get(
      '/employees/candidates',
      describeRoute({
        tags: ['Employees'],
        summary: 'Search colleagues; returns five columns and never email',
        description:
          'Requires employees.view. q is required, 1 to 64 characters, matched against name, username and employee number only. Active employees only; at most 50 rows per page.',
        operationId: 'searchEmployeeCandidates',
        responses: {
          '200': listResponse(EmployeeCandidateSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', EmployeeCandidatesQuery),
      async (context) => {
        const { q, departmentId, departmentIds, page, pageSize } =
          context.req.valid('query');
        await authorizeEmployees(context, 'view');
        const ids = [
          ...(departmentId === undefined ? [] : [departmentId]),
          ...(departmentIds === undefined ? [] : departmentIds.split(',')),
        ];
        const result = await reader.candidates({
          q,
          ...(ids.length === 0 ? {} : { departmentIds: ids }),
          page,
          pageSize,
        });
        return context.json({
          data: result.rows,
          meta: { page, pageSize, total: result.total },
        });
      },
    );

    router.post(
      '/employees/link',
      describeRoute({
        tags: ['Employees'],
        summary: 'Create a profile for an existing account',
        description:
          'Requires employees.manage, plus departments.manage when primaryDepartmentId is supplied.',
        operationId: 'linkEmployeeProfile',
        responses: {
          '201': dataResponse(EmployeeDetailSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', LinkEmployeeBody),
      async (context) => {
        const body = context.req.valid('json');
        await authorizeEmployees(context, 'manage');
        if (body.primaryDepartmentId != null) {
          await requireDepartmentManage(context);
        }
        const profile = await withMappedErrors(context, async () =>
          mutations.link(body, actorOf(context)),
        );
        return context.json({ data: await detailOf(profile.userId) }, 201);
      },
    );

    router.get(
      '/employees',
      describeRoute({
        tags: ['Employees'],
        summary: 'List employee profiles',
        description:
          'Requires employees.view. q matches name, username and employee number; email is never returned.',
        operationId: 'listEmployees',
        responses: {
          '200': listResponse(EmployeeListRowSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ListEmployeesQuery),
      async (context) => {
        const query = context.req.valid('query');
        await authorizeEmployees(context, 'view');
        const result = await reader.list(query);
        return context.json({
          data: result.rows,
          meta: { page: query.page, pageSize: query.pageSize, total: result.total },
        });
      },
    );

    router.post(
      '/employees',
      describeRoute({
        tags: ['Employees'],
        summary: 'Hire an employee: create the account and the profile in one transaction',
        description:
          'Requires employees.manage plus the users create and assign-role actions; departments.manage as well when primaryDepartmentId is supplied. Email and password are optional.',
        operationId: 'hireEmployee',
        responses: {
          '201': dataResponse(EmployeeDetailSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', HireEmployeeBody),
      async (context) => {
        const body = context.req.valid('json');
        await authorizeEmployees(context, 'manage');
        await requireAccountActions(context, 'create', 'assign-role');
        if (body.primaryDepartmentId != null) {
          await requireDepartmentManage(context);
        }
        const profile = await withMappedErrors(context, async () =>
          mutations.hire(body, actorOf(context)),
        );
        return context.json({ data: await detailOf(profile.userId) }, 201);
      },
    );

    router.get(
      '/employees/:userId/changes',
      describeRoute({
        tags: ['Employees'],
        summary: 'List an employee’s changes, newest first',
        description: 'Requires employees.view. The actor is returned as a name only.',
        operationId: 'listEmployeeChanges',
        responses: {
          '200': listResponse(EmployeeChangeSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeEmployees(context, 'view');
        const changes = await reader.changes(context.req.param('userId'));
        return context.json({ data: changes });
      },
    );

    router.post(
      '/employees/:userId/leave',
      describeRoute({
        tags: ['Employees'],
        summary: 'Process a departure in one transaction',
        description:
          'Requires employees.manage, departments.manage and the users disable action. Refuses managers, direct reports, an unspecified supervisor, self-departure and protected root accounts.',
        operationId: 'leaveEmployee',
        responses: {
          '201': dataResponse(EmployeeDetailSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', LeaveEmployeeBody),
      async (context) => {
        const body = context.req.valid('json');
        await authorizeEmployees(context, 'manage');
        await requireDepartmentManage(context);
        await requireAccountActions(context, 'disable');
        const profile = await withMappedErrors(context, async () =>
          mutations.leave(context.req.param('userId'), body, actorOf(context)),
        );
        return context.json({ data: await detailOf(profile.userId) }, 201);
      },
    );

    router.post(
      '/employees/:userId/rehire',
      describeRoute({
        tags: ['Employees'],
        summary: 'Rehire a former employee, keeping the employee number',
        description:
          'Requires employees.manage plus the users enable action; departments.manage as well when primaryDepartmentId is supplied.',
        operationId: 'rehireEmployee',
        responses: {
          '201': dataResponse(EmployeeDetailSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', RehireEmployeeBody),
      async (context) => {
        const body = context.req.valid('json');
        await authorizeEmployees(context, 'manage');
        await requireAccountActions(context, 'enable');
        if (body.primaryDepartmentId != null) {
          await requireDepartmentManage(context);
        }
        const profile = await withMappedErrors(context, async () =>
          mutations.rehire(context.req.param('userId'), body, actorOf(context)),
        );
        return context.json({ data: await detailOf(profile.userId) }, 201);
      },
    );

    router.get(
      '/employees/:userId',
      describeRoute({
        tags: ['Employees'],
        summary: 'Read one employee profile',
        operationId: 'readEmployee',
        responses: {
          '200': dataResponse(EmployeeDetailSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeEmployees(context, 'view');
        const row = await detailOf(context.req.param('userId'));
        return context.json({ data: row });
      },
    );

    router.patch(
      '/employees/:userId',
      describeRoute({
        tags: ['Employees'],
        summary: 'Change position, grade or reporting line',
        description: 'Requires employees.manage. At least one field is required.',
        operationId: 'updateEmployee',
        responses: {
          '200': dataResponse(EmployeeDetailSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateEmployeeBody),
      async (context) => {
        const body = context.req.valid('json');
        await authorizeEmployees(context, 'manage');
        const profile = await withMappedErrors(context, async () =>
          mutations.update(context.req.param('userId'), body, actorOf(context)),
        );
        return context.json({ data: await detailOf(profile.userId) });
      },
    );

    router.get(
      '/positions',
      describeRoute({
        tags: ['Employees'],
        summary: 'List positions; deactivated ones are still returned with active=false',
        operationId: 'listPositions',
        responses: {
          '200': listResponse(PositionSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeEmployees(context, 'view');
        return context.json({ data: await reader.positions() });
      },
    );

    router.post(
      '/positions',
      describeRoute({
        tags: ['Employees'],
        summary: 'Create a position code',
        operationId: 'createPosition',
        responses: {
          '201': dataResponse(PositionSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreatePositionBody),
      async (context) => {
        await authorizeEmployees(context, 'manage');
        const record = await withMappedErrors(context, async () =>
          mutations.createPosition(context.req.valid('json')),
        );
        return context.json({ data: record }, 201);
      },
    );

    router.patch(
      '/positions/:id',
      describeRoute({
        tags: ['Employees'],
        summary: 'Rename, reorder, deactivate or reactivate a position',
        operationId: 'updatePosition',
        responses: {
          '200': dataResponse(PositionSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdatePositionBody),
      async (context) => {
        await authorizeEmployees(context, 'manage');
        const record = await withMappedErrors(context, async () =>
          mutations.updatePosition(context.req.param('id'), context.req.valid('json')),
        );
        return context.json({ data: record });
      },
    );

    router.get(
      '/job-grades',
      describeRoute({
        tags: ['Employees'],
        summary: 'List job grades; deactivated ones are still returned with active=false',
        operationId: 'listJobGrades',
        responses: {
          '200': listResponse(JobGradeSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeEmployees(context, 'view');
        return context.json({ data: await reader.grades() });
      },
    );

    router.post(
      '/job-grades',
      describeRoute({
        tags: ['Employees'],
        summary: 'Create a job grade code',
        operationId: 'createJobGrade',
        responses: {
          '201': dataResponse(JobGradeSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateJobGradeBody),
      async (context) => {
        await authorizeEmployees(context, 'manage');
        const record = await withMappedErrors(context, async () =>
          mutations.createGrade(context.req.valid('json')),
        );
        return context.json({ data: record }, 201);
      },
    );

    router.patch(
      '/job-grades/:id',
      describeRoute({
        tags: ['Employees'],
        summary: 'Rename, rerank, deactivate or reactivate a job grade',
        operationId: 'updateJobGrade',
        responses: {
          '200': dataResponse(JobGradeSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateJobGradeBody),
      async (context) => {
        await authorizeEmployees(context, 'manage');
        const record = await withMappedErrors(context, async () =>
          mutations.updateGrade(context.req.param('id'), context.req.valid('json')),
        );
        return context.json({ data: record });
      },
    );

    return new Hono().route('/', router);
  },
);
