import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import { authorizationToken } from '@nocobase/app-plugin-authorization';
import type { AuthorizationDecision, CompositeResourceConditions } from '@nocobase/authorization/core';
import { expect } from 'vitest';

import { createAppTest } from '../helpers/test-app.js';
import { createStandaloneServer } from '../../server/standalone.js';

/**
 * R-011 员工业务资源的「注册」这一段（验收第 11 条里属于资源已注册的部分）。
 *
 * 这一片只声明、注册，不给任何角色授权、不建端点、不建页面。断言分三层：
 * 注册结果（表与动作都在、工作区位置对）、判定结果（注册的动作认得、未注册的连
 * root 也拒）、没有人授权时业务角色仍拒。判定之前应用已启动，provider 的 boot()
 * 已经跑过；没注册时动作会以 RESOURCE_ACTION_NOT_SUPPORTED 被拒，那种「被拒」
 * 不算数，所以先断言注册结果。判定恒为有条件放行，只看 effect 抓不住退化，
 * 因此连原因码与底层表的键一起断言。
 */

const test = createAppTest({
  createServer: createStandaloneServer,
  config: {
    app: { publicOrigin: 'http://localhost' },
    auth: { secret: 'test-auth-secret-at-least-32-characters' },
  },
});

const json = (body: unknown) => ({
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    origin: 'http://localhost',
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

const EMPLOYEE_TABLES = [
  'employees',
  'employeeChanges',
  'positions',
  'jobGrades',
] as const;
const EMPLOYEE_ACTIONS = ['view', 'manage'] as const;
const PASSWORD = 'R011-test-123!';

/**
 * 注册表 → 动作 → 列。独立写在测试里，不从声明导入常量：声明被放宽时测试必须红。
 * 依据 R-011.md:232-234/239 的逐列口径；端点仍按契约裁输出（列表不带离职日期等）。
 */
const EXPECTED_FIELDS: Readonly<
  Record<string, Readonly<Record<string, readonly string[]>>>
> = {
  view: {
    employees: {
      read: [
        'id',
        'userId',
        'employeeNo',
        'positionId',
        'gradeId',
        'reportsToUserId',
        'status',
        'hiredOn',
        'leftOn',
      ],
    },
    employeeChanges: {
      read: [
        'userId',
        'kind',
        'fromValue',
        'toValue',
        'occurredOn',
        'note',
        'actorId',
        'createdAt',
      ],
    },
    positions: { read: ['id', 'title', 'active', 'sortOrder'] },
    jobGrades: { read: ['id', 'title', 'rank', 'active'] },
  },
  manage: {
    employees: {
      read: [
        'id',
        'userId',
        'employeeNo',
        'positionId',
        'gradeId',
        'reportsToUserId',
        'status',
        'hiredOn',
        'leftOn',
      ],
      create: [
        'userId',
        'employeeNo',
        'positionId',
        'gradeId',
        'reportsToUserId',
        'hiredOn',
        'status',
      ],
      update: [
        'positionId',
        'gradeId',
        'reportsToUserId',
        'status',
        'leftOn',
        'hiredOn',
      ],
    },
    employeeChanges: {
      create: [
        'userId',
        'kind',
        'fromValue',
        'toValue',
        'occurredOn',
        'note',
        'actorId',
      ],
    },
    positions: {
      read: ['id', 'title', 'active', 'sortOrder'],
      create: ['id', 'title', 'active', 'sortOrder'],
      update: ['title', 'active', 'sortOrder'],
    },
    jobGrades: {
      read: ['id', 'title', 'rank', 'active'],
      create: ['id', 'title', 'rank', 'active'],
      update: ['title', 'rank', 'active'],
    },
  },
};

/** 设计明确不存、更不该被读走的列（R-011.md:17、73、252）。 */
const SENSITIVE_FIELDS = [
  'email',
  'phone',
  'mobile',
  'idnumber',
  'idcard',
  'address',
  'emergencycontact',
  'nationalid',
  'bankaccount',
  'salary',
];

type RegisteredGrant = {
  resource: { type: string; id: string };
  actions: {
    action: string;
    policy: { type: string; fields: '*' | readonly string[] };
  }[];
};
type RegisteredAction = { grants: RegisteredGrant[] };

/** 从注册模型里取「表 → 动作 → 列」；列被放宽成 '*' 时原样返回。 */
const registeredFields = (
  app: { container: { resolve: (token: typeof authorizationToken) => unknown } },
  action: string,
): Readonly<Record<string, Readonly<Record<string, '*' | readonly string[]>>>> => {
  const authz = app.container.resolve(authorizationToken) as {
    compositeResources: {
      getAction: (resource: string, name: string) => unknown;
    };
  };
  const definition = authz.compositeResources.getAction(
    'employees',
    action,
  ) as RegisteredAction | undefined;
  expect(definition, `employees.${action} 没有注册`).toBeDefined();
  const fields: Record<string, Record<string, '*' | readonly string[]>> = {};
  for (const grant of definition!.grants) {
    for (const registered of grant.actions) {
      fields[grant.resource.id] ??= {};
      fields[grant.resource.id][registered.action] = registered.policy.fields;
    }
  }
  return fields;
};

const codes = (decision: { readonly reasons: readonly { code: string }[] }) =>
  decision.reasons.map((reason) => reason.code);

type EmployeeDecision = AuthorizationDecision<CompositeResourceConditions>;

/** 建一个用户；不传 roleScopes 时框架会给它 member。 */
const createUser = async (
  admin: TestSession,
  name: string,
  roleScopes?: Record<string, string[]>,
): Promise<{ id: string }> => {
  const response = await admin.fetch(
    '/users',
    json({
      name,
      username: name,
      email: `${name}@example.test`,
      password: PASSWORD,
      ...(roleScopes === undefined ? {} : { roleScopes }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json()).data as { id: string };
};

// 注册后四张表带正确的动作清单、两个动作在工作区 organization 分节、裸表不进角色编辑器。
test('R-011: registers the four employee tables with the two actions and the workspace entry', async ({
  app,
}) => {
  const authz = app.container.resolve(authorizationToken);
  for (const table of EMPLOYEE_TABLES) {
    expect(authz.database.collections.has(table), `${table} 没有注册`).toBe(
      true,
    );
    const definition = authz.database.collections
      .list()
      .find((collection) => collection.name === table);
    expect(
      definition?.actions,
      `${table} 的登记动作与设计不符`,
    ).toEqual(
      table === 'employees' || table === 'positions' || table === 'jobGrades'
        ? ['read', 'create', 'update']
        : ['read', 'create'],
    );
  }
  for (const action of EMPLOYEE_ACTIONS) {
    expect(
      authz.compositeResources.getAction('employees', action),
      `employees.${action} 没有注册`,
    ).toBeDefined();
  }
  expect(authz.compositeResources.getAction('employees', 'view')?.title).toEqual({
    key: 'authorization.employees.actions.view',
    ns: 'app-local',
  });
  expect(
    authz.compositeResources.getAction('employees', 'manage')?.title,
  ).toEqual({
    key: 'authorization.employees.actions.manage',
    ns: 'app-local',
  });
  expect(authz.ui.placementOf({ type: 'composite', id: 'employees' })).toEqual({
    section: 'organization',
  });
  // 四张表只供业务动作展开，不进角色编辑器：没有 placement。
  for (const table of EMPLOYEE_TABLES) {
    expect(
      authz.ui.placementOf({ type: 'database.collection', id: table }),
      `${table} 被放进了角色编辑器`,
    ).toBeUndefined();
  }
});

// 每张表每个动作登记的列与清单逐项相等：拿掉一列、多一列、放宽成 '*' 或补一个 delete 都要红。
test('R-011: each action registers exactly the designed table, operation and columns', async ({
  app,
}) => {
  for (const action of EMPLOYEE_ACTIONS) {
    const actual = registeredFields(app, action);
    const expected = EXPECTED_FIELDS[action];
    expect(Object.keys(actual).sort(), `${action} 的表集合不对`).toEqual(
      Object.keys(expected).sort(),
    );
    for (const table of Object.keys(expected)) {
      expect(
        Object.keys(actual[table] ?? {}).sort(),
        `${action}.${table} 的动作集合不对`,
      ).toEqual(Object.keys(expected[table]).sort());
      for (const operation of Object.keys(expected[table])) {
        const registered = actual[table]?.[operation];
        expect(
          registered,
          `${action}.${table}.${operation} 不应该被放宽成全列`,
        ).not.toBe('*');
        expect(
          [...(registered as readonly string[])].sort(),
          `${action}.${table}.${operation} 的列不对`,
        ).toEqual([...expected[table][operation]].sort());
      }
    }
  }

  // 读列不许出现联系方式、证件、住址这一类列（设计的数据模型里也没有）。
  for (const table of Object.keys(EXPECTED_FIELDS.view)) {
    for (const field of registeredFields(app, 'view')[table]?.read ?? []) {
      expect(
        SENSITIVE_FIELDS.includes(field.toLowerCase()),
        `view.${table} 的读列带了敏感列 ${field}`,
      ).toBe(false);
    }
  }
});

// 注册的动作被授权检查认得：root 放行、业务角色没人授权仍拒、未注册动作连 root 也拒。
test('R-011: registered actions are recognized while ungranted roles and unregistered actions are denied', async ({
  testApp,
  app,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const authz = app.container.resolve(authorizationToken);
  const forUser = (id: string) =>
    authz.for({ principal: { type: 'user', id } });
  const root = forUser(String(admin.user.id));

  // 未注册的动作连 root 都以 RESOURCE_ACTION_NOT_SUPPORTED 拒绝。
  const unknown = await root.authorize({
    resource: { type: 'composite', id: 'employees' },
    action: 'r011UnregisteredAction',
  });
  expect(unknown.effect, '未注册的动作连 root 都该被拒').toBe('deny');
  expect(codes(unknown)).toContain('RESOURCE_ACTION_NOT_SUPPORTED');

  // 注册后的两个动作认得：root 不受限，底层四张表的键都在。
  for (const action of EMPLOYEE_ACTIONS) {
    const decision: EmployeeDecision = await root.authorize({
      resource: { type: 'composite', id: 'employees' },
      action,
    });
    expect(decision.effect, `root 被拒了 employees.${action}`).toBe(
      'conditional',
    );
    expect(codes(decision)).toContain('UNRESTRICTED_ACCESS');
    expect(Object.keys(decision.conditions?.database ?? {}).sort()).toEqual(
      [...EMPLOYEE_TABLES].sort(),
    );
  }

  // 没有人授权时业务角色与没有角色的用户调用都拒，且不是「未注册」那种拒。
  const staff = await createUser(admin, 'r011staff', { app: ['staff'] });
  const nobody = await createUser(admin, 'r011nobody', { app: [] });
  for (const user of [staff, nobody]) {
    for (const action of EMPLOYEE_ACTIONS) {
      const denied = await forUser(user.id).authorize({
        resource: { type: 'composite', id: 'employees' },
        action,
      });
      expect(denied.effect, `${user.id} 不应当能 ${action}`).toBe('deny');
      expect(codes(denied)).toContain('NO_MATCHING_GRANT');
    }
  }
});

// 权限工作区目录里出现 employees 的两个动作、四张表的数据范围，且没有部门范围键。
test('R-011: the role editor catalogue lists the two employee actions in the organization section', async ({
  testApp,
}) => {
  const admin = await signIn(testApp, DEFAULT_ADMIN_CREDENTIALS);
  const response = await admin.fetch('/authorization/permissionSets/options');
  expect(response.status).toBe(200);
  const options = (await response.json()).data as {
    sections: {
      name: string;
      subsections: {
        name: string;
        resources: {
          id: string;
          actions: { name: string }[];
          dataScopes?: Record<
            string,
            { key: string; collection: string; recordAccess: string[] }[]
          >;
        }[];
      }[];
    }[];
  };
  const business = options.sections.find(
    (section) => section.name === 'business',
  );
  const organization = business?.subsections.find(
    (subsection) => subsection.name === 'organization',
  );
  const employees = organization?.resources.find(
    (resource) => resource.id === 'employees',
  );
  expect(employees, '工作区目录里没有「组织」下的 employees').toBeDefined();
  expect(employees?.actions.map((action) => action.name)).toEqual([
    ...EMPLOYEE_ACTIONS,
  ]);
  for (const action of EMPLOYEE_ACTIONS) {
    const scopes = employees?.dataScopes?.[action] ?? [];
    expect(scopes.map((scope) => scope.collection).sort()).toEqual(
      [...EMPLOYEE_TABLES].sort(),
    );
    for (const scope of scopes) {
      expect(scope.recordAccess).toContain('allRecords');
      // 员工表没有 departmentId 列，部门范围键不该出现在这里。
      expect(scope.recordAccess).not.toContain('org.myDepartments');
      expect(scope.recordAccess).not.toContain('org.myDepartmentsAndBelow');
    }
  }
});
