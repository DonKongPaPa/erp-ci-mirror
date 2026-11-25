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
  databaseManagerToken,
  isUniqueConstraintViolation,
} from '@nocobase/db';
import {
  ApiError,
  apiErrorResponse,
  apiValidator,
  dataResponse,
  defineApiRoutes,
  describeRoute,
  listResponse,
  type AppApiRouteContribution,
} from '@nocobase/app-server/router';
import { Hono, type Context } from 'hono';

import {
  AddMembersBody,
  AddMembersResultSchema,
  CandidateQuery,
  CandidateSchema,
  CreateDepartmentBody,
  DeactivateDepartmentBody,
  DepartmentMemberSchema,
  DepartmentSchema,
  DepartmentTreeNodeSchema,
  ListDepartmentMembersQuery,
  MembershipSchema,
  MergeDepartmentBody,
  MergeResultSchema,
  TransferMembersBody,
  TransferResultSchema,
  UpdateDepartmentBody,
} from './department-schemas.js';
import {
  departmentMutationsToken,
  type DepartmentRecord,
} from '../providers/department-mutations.js';
import {
  DepartmentRuleError,
  type DepartmentRuleCode,
} from '../providers/departments.js';

type DepartmentAction = 'view' | 'manage';
type DepartmentDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 规则码到 HTTP 状态。设计的状态码表：409 是常态，少数几条是 422，缺对象是 404。 */
const RULE_STATUS: Readonly<Partial<Record<DepartmentRuleCode, number>>> = {
  'department-not-found': 404,
  'membership-not-found': 404,
  'manager-not-member': 422,
  'invalid-department-kind': 422,
  'title-required': 422,
  'code-required': 422,
  'parent-not-found': 422,
  'merge-target-self': 422,
  'merge-target-deactivated': 422,
  'merge-target-not-found': 422,
  'transfer-invalid-request': 422,
  'transfer-target-not-found': 422,
};

/** 422 没有共享的错误响应组件（框架的状态表里没有 422），照 R-037 的做法就地声明。 */
const unprocessableResponse = {
  description: 'The request violates a department rule (422).',
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/ApiErrorBody' },
    },
  },
} as const;

function reasonOf(code: DepartmentRuleCode): string {
  return code.replaceAll('-', '_').toUpperCase();
}

/**
 * 规则错误、唯一约束冲突到 `/api` 错误的映射。
 *
 * 设计里五处 422 不在框架的状态表里，用 `httpStatus` 显式覆盖（R-037 的切换
 * 接口已经这么用过）。设主部门撞上部分唯一索引是并发冲突：409。
 */
export function departmentApiError(error: unknown): ApiError | null {
  if (error instanceof DepartmentRuleError) {
    const httpStatus = RULE_STATUS[error.code] ?? 409;
    return new ApiError({
      status:
        httpStatus === 404
          ? 'NOT_FOUND'
          : httpStatus === 422
            ? 'FAILED_PRECONDITION'
            : error.code === 'duplicate-title' ||
                error.code === 'duplicate-code'
              ? 'ALREADY_EXISTS'
              : 'ABORTED',
      reason: reasonOf(error.code),
      domain: 'departments',
      message: `Department rule violated: ${error.code}.`,
      ...(httpStatus === 422 ? { httpStatus: 422 as const } : {}),
    });
  }
  if (isUniqueConstraintViolation(error)) {
    return new ApiError({
      status: 'ALREADY_EXISTS',
      reason: 'PRIMARY_DEPARTMENT_CONFLICT',
      domain: 'departments',
      message:
        'Another session set a primary department for this user at the same time.',
    });
  }
  return null;
}

/**
 * 部门端点的一次授权。一个请求只授权一次；被拒就在这一步抛 403，
 * 后面碰请求体、开事务之前就已经结束。
 *
 * 不用 `require`：业务动作授权成功的结果是「有条件放行」，`require` 对它一律拒绝
 * （R-013 的做法）。
 */
async function authorizeDepartments(
  context: Context<AuthEnv & AuthorizationEnv>,
  action: DepartmentAction,
): Promise<DepartmentDecision> {
  const decision = await context.get('authz').authorize({
    resource: { type: 'composite', id: 'departments' },
    action,
  });
  if (decision.effect === 'deny') {
    throw new AuthorizationDeniedError(decision);
  }
  return decision;
}

/** 操作人。`auth.required()` 已经挡过未登录，这里是给类型收窄的兜底。 */
function actorOf(context: Context<AuthEnv & AuthorizationEnv>): string {
  const session = context.get('auth');
  if (session === null) {
    throw new ApiError({
      status: 'UNAUTHENTICATED',
      reason: 'AUTHENTICATION_REQUIRED',
      domain: 'departments',
      message: 'An authenticated user is required.',
    });
  }
  return session.user.id;
}

function missingDepartment(): ApiError {
  return new ApiError({
    status: 'NOT_FOUND',
    reason: 'DEPARTMENT_NOT_FOUND',
    domain: 'departments',
    message: 'The department was not found.',
  });
}

/** 排序：同级按 sortOrder，再按名称与 id，结果稳定。 */
function compareDepartments(
  left: DepartmentRecord,
  right: DepartmentRecord,
): number {
  if (left.sortOrder !== right.sortOrder) {
    return left.sortOrder - right.sortOrder;
  }
  if (left.title !== right.title) {
    return left.title < right.title ? -1 : 1;
  }
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}

/**
 * 把整棵树拼成嵌套结构。父节点不存在的行（数据违反不变量）放在根上，
 * 免得它们从 `/tree` 里消失；有环的行不会成为任何根的后代，自然不出现。
 */
function buildTree(
  rows: readonly DepartmentRecord[],
): readonly (DepartmentRecord & { children: unknown[] })[] {
  const known = new Set(rows.map((row) => row.id));
  const children = new Map<string | null, DepartmentRecord[]>();
  for (const row of rows) {
    const parentId =
      row.parentId !== null && known.has(row.parentId) ? row.parentId : null;
    const siblings = children.get(parentId) ?? [];
    siblings.push(row);
    children.set(parentId, siblings);
  }

  const visit = (
    parentId: string | null,
    ancestors: ReadonlySet<string>,
  ): (DepartmentRecord & { children: unknown[] })[] =>
    (children.get(parentId) ?? [])
      .filter((row) => !ancestors.has(row.id))
      .sort(compareDepartments)
      .map((row) => ({
        ...row,
        children: visit(row.id, new Set([...ancestors, row.id])),
      }));

  return visit(null, new Set());
}

/**
 * R-012 部门管理的人用端点。
 *
 * 读要 `departments.view`，写要 `departments.manage`，动作挂在 `departments` 这个
 * 业务资源上，做法照 R-013（`server/routes/quality.ts`）。每个请求只授权一次。
 * 写端点的 Origin 校验由 `auth.required()` 负责：带 cookie 的非 GET 请求缺 Origin
 * 直接 403，路由上不用显式写。
 */
export const apiRoutes: AppApiRouteContribution<Application> = defineApiRoutes(
  (app) => {
    const router = new Hono<AuthEnv & AuthorizationEnv>();
    const auth = app.container.resolve(authenticationToken);
    const authz = app.container.resolve(authorizationToken);
    const database = app.container.resolve(databaseManagerToken);
    const mutations = app.container.resolve(departmentMutationsToken);

    router.use('/departments', auth.required(), authz.middleware());
    router.use('/departments/*', auth.required(), authz.middleware());

    const withMappedErrors = async <T>(work: () => Promise<T>): Promise<T> => {
      try {
        return await work();
      } catch (error) {
        const mapped = departmentApiError(error);
        if (mapped !== null) {
          throw mapped;
        }
        throw error;
      }
    };

    router.get(
      '/departments/tree',
      describeRoute({
        tags: ['Departments'],
        summary: 'Read the whole department tree',
        operationId: 'readDepartmentTree',
        responses: {
          '200': dataResponse(DepartmentTreeNodeSchema.array()),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        await authorizeDepartments(context, 'view');
        const rows = await database
          .repository<DepartmentRecord>('departments')
          .findMany();
        return context.json({ data: buildTree(rows) });
      },
    );

    router.get(
      '/departments/candidates',
      describeRoute({
        tags: ['Departments'],
        summary:
          'Search people to add as members; returns user id, name and username only',
        description:
          'Requires departments.manage. The query is required: 1 to 64 characters after trimming. Matches names and usernames case-insensitively. Returns 20 rows per page by default, at most 50. Disabled and deleted accounts are left out; excludeDepartmentId leaves out that department’s current members.',
        operationId: 'listDepartmentCandidates',
        responses: {
          '200': listResponse(CandidateSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', CandidateQuery),
      async (context) => {
        const { q, excludeDepartmentId, page, pageSize } =
          context.req.valid('query');
        await authorizeDepartments(context, 'manage');

        // 排除参数只是「这个部门的现有成员」；部门不存在时没有成员可排，结果为空集。
        const excluded =
          excludeDepartmentId === undefined
            ? []
            : (
                await database
                  .repository<{ departmentId: string; userId: string }>(
                    'departmentMembers',
                  )
                  .findMany({ filter: { departmentId: excludeDepartmentId } })
              ).map((membership) => membership.userId);

        // 读用户表走服务端内部读，不经授权（R-028：读人员信息只做选择性暴露）。
        // 只取三列；停用与删除的账户不出现。`fn.lower` 是两种方言都可用的写法。
        const term = `%${q.toLowerCase()}%`;
        const query = database.connection().query;
        const build = () => {
          let select = query
            .selectFrom('user')
            .where('deletedAt', 'is', null)
            .where('disabledAt', 'is', null)
            .where((eb) =>
              eb.or([
                eb(eb.fn.lower('name'), 'like', term),
                eb(eb.fn.lower('username'), 'like', term),
              ]),
            );
          if (excluded.length > 0) {
            select = select.where('id', 'not in', excluded);
          }
          return select;
        };

        const rows = await build()
          .select(['id', 'name', 'username'])
          .orderBy('name', 'asc')
          .orderBy('id', 'asc')
          .limit(pageSize)
          .offset((page - 1) * pageSize)
          .execute();
        const totalRow = await build()
          .select((eb) => [eb.fn.countAll<number>().as('total')])
          .executeTakeFirst<{ total: number }>();
        const total = Number(totalRow?.total ?? 0);

        return context.json({
          data: rows.map((row) => ({
            userId: String(row.id),
            name: typeof row.name === 'string' ? row.name : null,
            username: typeof row.username === 'string' ? row.username : null,
          })),
          meta: { page, pageSize, total },
        });
      },
    );

    router.get(
      '/departments/:id/members',
      describeRoute({
        tags: ['Departments'],
        summary: 'List the members of a department',
        description:
          'Each row has the member’s user id, name, username and whether this is their primary department. Email is never returned.',
        operationId: 'listDepartmentMembers',
        responses: {
          '200': listResponse(DepartmentMemberSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('query', ListDepartmentMembersQuery),
      async (context) => {
        const departmentId = context.req.param('id');
        const { page, pageSize } = context.req.valid('query');
        await authorizeDepartments(context, 'view');
        const department = await database
          .repository<DepartmentRecord>('departments')
          .findOne({ filter: { id: departmentId } });
        if (department === undefined) {
          throw missingDepartment();
        }
        const repo = database.repository<{
          id: string;
          departmentId: string;
          userId: string;
          isPrimary: boolean;
          createdAt: Date | string;
        }>('departmentMembers');
        const memberships = await repo.findMany({
          filter: { departmentId },
          limit: pageSize,
          offset: (page - 1) * pageSize,
          sort: {
            kind: 'sort',
            version: 1,
            items: [
              { kind: 'field', path: ['createdAt'], direction: 'asc' },
              { kind: 'field', path: ['id'], direction: 'asc' },
            ],
          },
        });
        const total = await repo.count({ filter: { departmentId } });

        // 姓名与用户名走服务端内部读，不经授权（R-028：读人员信息只做选择性暴露）。
        const userIds = [...new Set(memberships.map((row) => row.userId))];
        const users =
          userIds.length === 0
            ? []
            : await database
                .connection()
                .query.selectFrom('user')
                .where('id', 'in', userIds)
                .select(['id', 'name', 'username'])
                .execute();
        const byId = new Map(
          users.map((user) => [String(user.id), user] as const),
        );
        const data = memberships.map((membership) => {
          const user = byId.get(membership.userId);
          return {
            userId: membership.userId,
            name: typeof user?.name === 'string' ? user.name : null,
            username: typeof user?.username === 'string' ? user.username : null,
            // 成员关系的事实，不是个人属性；页面的「主部门」标记靠它。
            isPrimary: membership.isPrimary,
          };
        });
        return context.json({ data, meta: { page, pageSize, total } });
      },
    );

    router.post(
      '/departments',
      describeRoute({
        tags: ['Departments'],
        summary: 'Create a department',
        operationId: 'createDepartment',
        responses: {
          '201': dataResponse(DepartmentSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', CreateDepartmentBody),
      async (context) => {
        const body = context.req.valid('json');
        await authorizeDepartments(context, 'manage');
        const record = await withMappedErrors(
          async () => await mutations.createDepartment(body),
        );
        return context.json({ data: record }, 201);
      },
    );

    router.patch(
      '/departments/:id',
      describeRoute({
        tags: ['Departments'],
        summary: 'Update a department',
        operationId: 'updateDepartment',
        responses: {
          '200': dataResponse(DepartmentSchema),
          '400': apiErrorResponse(400),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', UpdateDepartmentBody),
      async (context) => {
        const departmentId = context.req.param('id');
        const body = context.req.valid('json');
        await authorizeDepartments(context, 'manage');
        const record = await withMappedErrors(
          async () => await mutations.updateDepartment(departmentId, body),
        );
        return context.json({ data: record });
      },
    );

    router.post(
      '/departments/:id/deactivate',
      describeRoute({
        tags: ['Departments'],
        summary: 'Deactivate a department, optionally naming its successor',
        operationId: 'deactivateDepartment',
        responses: {
          '200': dataResponse(DepartmentSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', DeactivateDepartmentBody),
      async (context) => {
        const departmentId = context.req.param('id');
        const body = context.req.valid('json');
        await authorizeDepartments(context, 'manage');
        const record = await withMappedErrors(
          async () => await mutations.deactivateDepartment(departmentId, body),
        );
        return context.json({ data: record });
      },
    );

    router.post(
      '/departments/:id/activate',
      describeRoute({
        tags: ['Departments'],
        summary: 'Activate a department',
        operationId: 'activateDepartment',
        responses: {
          '200': dataResponse(DepartmentSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const departmentId = context.req.param('id');
        await authorizeDepartments(context, 'manage');
        const record = await withMappedErrors(
          async () => await mutations.activateDepartment(departmentId),
        );
        return context.json({ data: record });
      },
    );

    router.post(
      '/departments/:id/members',
      describeRoute({
        tags: ['Departments'],
        summary: 'Add members to a department',
        operationId: 'addDepartmentMembers',
        responses: {
          '200': dataResponse(AddMembersResultSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', AddMembersBody),
      async (context) => {
        const departmentId = context.req.param('id');
        const body = context.req.valid('json');
        await authorizeDepartments(context, 'manage');
        const result = await withMappedErrors(
          async () =>
            await mutations.addMembers(
              departmentId,
              body.userIds ?? [],
              actorOf(context),
            ),
        );
        return context.json({ data: result });
      },
    );

    router.delete(
      '/departments/:id/members/:userId',
      describeRoute({
        tags: ['Departments'],
        summary: 'Remove a member from a department',
        operationId: 'removeDepartmentMember',
        responses: {
          '200': dataResponse(MembershipSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const departmentId = context.req.param('id');
        const userId = context.req.param('userId');
        await authorizeDepartments(context, 'manage');
        const membership = await withMappedErrors(
          async () =>
            await mutations.removeMember(
              departmentId,
              userId,
              actorOf(context),
            ),
        );
        return context.json({ data: membership });
      },
    );

    router.post(
      '/departments/:id/members/:userId/primary',
      describeRoute({
        tags: ['Departments'],
        summary: 'Make a department the primary department of a member',
        operationId: 'setPrimaryDepartment',
        responses: {
          '200': dataResponse(MembershipSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '500': apiErrorResponse(500),
        },
      }),
      async (context) => {
        const departmentId = context.req.param('id');
        const userId = context.req.param('userId');
        await authorizeDepartments(context, 'manage');
        const membership = await withMappedErrors(
          async () =>
            await mutations.setPrimaryDepartment(
              departmentId,
              userId,
              actorOf(context),
            ),
        );
        return context.json({ data: membership });
      },
    );

    router.post(
      '/departments/:id/merge',
      describeRoute({
        tags: ['Departments'],
        summary: 'Merge a department into another one',
        operationId: 'mergeDepartment',
        responses: {
          '200': dataResponse(MergeResultSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '404': apiErrorResponse(404),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', MergeDepartmentBody),
      async (context) => {
        const sourceId = context.req.param('id');
        const body = context.req.valid('json');
        await authorizeDepartments(context, 'manage');
        const targetId = body.targetId;
        if (targetId === undefined) {
          throw new ApiError({
            status: 'FAILED_PRECONDITION',
            reason: 'DEPARTMENT_MERGE_TARGET_REQUIRED',
            domain: 'departments',
            message: 'A merge needs a target department.',
            httpStatus: 422,
          });
        }
        const result = await withMappedErrors(
          async () =>
            await mutations.mergeDepartments(
              sourceId,
              targetId,
              actorOf(context),
            ),
        );
        return context.json({ data: result });
      },
    );

    router.post(
      '/departments/members/transfer',
      describeRoute({
        tags: ['Departments'],
        summary: 'Move a batch of users from one department to another',
        operationId: 'transferDepartmentMembers',
        responses: {
          '200': dataResponse(TransferResultSchema),
          '401': apiErrorResponse(401),
          '403': apiErrorResponse(403),
          '409': apiErrorResponse(409),
          '422': unprocessableResponse,
          '500': apiErrorResponse(500),
        },
      }),
      apiValidator('json', TransferMembersBody),
      async (context) => {
        const body = context.req.valid('json');
        await authorizeDepartments(context, 'manage');
        const result = await withMappedErrors(
          async () =>
            await mutations.transferMembers(
              {
                userIds: body.userIds ?? [],
                fromDepartmentId: body.fromDepartmentId ?? '',
                toDepartmentId: body.toDepartmentId ?? '',
              },
              actorOf(context),
            ),
        );
        return context.json({ data: result });
      },
    );

    return new Hono().route('/', router);
  },
);
