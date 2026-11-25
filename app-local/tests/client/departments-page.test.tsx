import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

import {
  DEFAULT_ADMIN_CREDENTIALS,
  signIn,
  type TestSession,
} from '@nocobase/app-plugin-authentication/testing';
import type { TestApp } from '@nocobase/app-testing/server';

import DepartmentsPage from '../../client/pages/settings/departments/index.js';
import {
  createAuthenticatedClientRenderer,
  renderAuthenticatedClient,
} from '../helpers/authenticated-client.js';

/**
 * R-012 部门维护页的验收（第 10 条之前在 playwright 里走真应用，这里走真实进程内服务器）。
 *
 * 每条测试用自己的部门与用户，互不相撞。页面只能经真实接口拿到数据：
 * 这里不替接口回答，服务端就是被测的一半。
 *
 * 操作之后才出现的元素或状态一律用 `findBy*` / `waitFor` 等（远端机器慢，同步的
 * `getBy*` 会在数据回来之前抓空）；断言「不存在」的 `queryBy*` 是同步的，保持原样。
 *
 * 原来「建树 → 加成员 → 设负责人 → 停用」是一条测试，远端负载高时所有步骤一起变慢，
 * 总和会越过默认的 30 秒。拆成三条共享同一服务端前置的小测试：每条有自己的超时预算，
 * 前置数据走真实接口在 `prepare` 里建好，被测的那一步仍然走页面。
 */
const PASSWORD = 'R012-page-123!';
const APPLICATION_ORIGIN = 'http://localhost';

/** 一次写操作之后要等的数据往返；远端 CI 比本机慢一个量级。 */
const SLOW = { timeout: 30_000 } as const;
const WAIT = { timeout: 15_000 } as const;

const renderShared = createAuthenticatedClientRenderer();

const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 8);

const json = (body: unknown, method = 'POST') => ({
  method,
  headers: {
    'content-type': 'application/json',
    origin: APPLICATION_ORIGIN,
    'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
  },
  body: JSON.stringify(body),
});

interface DepartmentRow {
  id: string;
  title: string;
  code: string;
}

interface UserRow {
  id: string;
  name: string;
  username: string;
}

const createDepartment = async (
  session: TestSession,
  input: Record<string, unknown>,
): Promise<DepartmentRow> => {
  const response = await session.fetch('/departments', json(input));
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: DepartmentRow }).data;
};

const createUser = async (
  session: TestSession,
  name: string,
  username: string,
): Promise<UserRow> => {
  const response = await session.fetch(
    '/users',
    json({
      name,
      username,
      email: `${username}@example.test`,
      password: PASSWORD,
      roleScopes: { app: [] },
    }),
  );
  const text = await response.text();
  expect(response.status, `${text}`).toBe(201);
  return (JSON.parse(text) as { data: UserRow }).data;
};

/** 小测试的前置：用真实接口建一棵根 + 子部门，把页面操作留给被测的那一步。 */
const seedTree = async (
  session: TestSession,
  rootTitle: string,
  rootCode: string,
  childTitle: string,
  childCode: string,
): Promise<{ root: DepartmentRow; child: DepartmentRow }> => {
  const root = await createDepartment(session, {
    title: rootTitle,
    code: rootCode,
  });
  const child = await createDepartment(session, {
    title: childTitle,
    code: childCode,
    parentId: root.id,
  });
  return { root, child };
};

const addMembers = async (
  session: TestSession,
  departmentId: string,
  userIds: readonly string[],
): Promise<void> => {
  const response = await session.fetch(
    `/departments/${departmentId}/members`,
    json({ userIds }),
  );
  expect(response.status, `${await response.clone().text()}`).toBe(200);
};

const patchDepartment = async (
  session: TestSession,
  departmentId: string,
  input: Record<string, unknown>,
): Promise<void> => {
  const response = await session.fetch(
    `/departments/${departmentId}`,
    json(input, 'PATCH'),
  );
  expect(response.status, `${await response.clone().text()}`).toBe(200);
};

const pageAccessGrant = {
  resource: { type: 'page', id: 'departments' },
  actions: [{ action: 'access' }],
};
const viewGrant = {
  resource: { type: 'composite', id: 'departments' },
  actions: [{ action: 'view' }],
};

const escape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 树里某一行的选择按钮：名称以部门标题开头（展开按钮的名称以 Expand 开头）。 */
const treeRow = async (title: string): Promise<HTMLElement> => {
  const tree = await screen.findByRole(
    'navigation',
    { name: 'Department tree' },
    SLOW,
  );
  return await within(tree).findByRole(
    'button',
    { name: new RegExp(`^${escape(title)}`) },
    SLOW,
  );
};

/** 等对话框关掉：写操作成功之后才发生。 */
const dialogClosed = async (): Promise<void> => {
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WAIT);
};

it('creates a department tree, adds a member and makes them primary', async () => {
  const user = userEvent.setup();
  const suffix = unique();
  const rootTitle = `Root${suffix}`;
  const rootCode = `ROOT${suffix}`;
  const childTitle = `Child${suffix}`;
  const childCode = `CHILD${suffix}`;
  const memberName = `Alice${suffix}`;
  const memberUsername = `alice${suffix}`;

  await renderShared(<DepartmentsPage />, {
    route: '/settings/departments',
    prepare: async (_server: TestApp, session: TestSession) => {
      await createUser(session, memberName, memberUsername);
    },
  });

  // 建根部门。
  await user.click(
    await screen.findByRole('button', { name: 'New department' }, SLOW),
  );
  let dialog = await screen.findByRole('dialog', undefined, SLOW);
  await user.type(within(dialog).getByLabelText('Name'), rootTitle);
  await user.type(within(dialog).getByLabelText('Code'), rootCode);
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await dialogClosed();
  await treeRow(rootTitle);

  // 建子部门：新建后选中根，对话框默认上级就是根。
  await user.click(
    await screen.findByRole('button', { name: 'New department' }, SLOW),
  );
  dialog = await screen.findByRole('dialog', undefined, SLOW);
  await user.type(within(dialog).getByLabelText('Name'), childTitle);
  await user.type(within(dialog).getByLabelText('Code'), childCode);
  await user.click(within(dialog).getByRole('button', { name: 'Create' }));
  await dialogClosed();
  await treeRow(childTitle);

  // 选中根，加一个成员：搜人结果里勾选。
  await user.click(await treeRow(rootTitle));
  await user.click(
    await screen.findByRole('button', { name: 'Add members' }, SLOW),
  );
  dialog = await screen.findByRole('dialog', undefined, SLOW);
  await user.type(within(dialog).getByLabelText('Search'), memberName);
  await user.click(within(dialog).getByRole('button', { name: 'Search' }));
  const checkbox = await within(dialog).findByRole(
    'checkbox',
    { name: new RegExp(escape(memberName)) },
    SLOW,
  );
  await user.click(checkbox);
  await user.click(
    within(dialog).getByRole('button', { name: 'Add selected' }),
  );
  await dialogClosed();
  const members = await screen.findByRole('region', { name: 'Members' }, SLOW);
  expect(
    await within(members).findByText(memberName, undefined, SLOW),
  ).toBeVisible();
  expect(
    await within(members).findByText(memberUsername, undefined, SLOW),
  ).toBeVisible();
  // 成员区与搜人结果都不回邮箱。
  expect(document.body.textContent).not.toContain('@example.test');
  // 刚加入时不是主部门；设为主部门之后，成员行上的标记跟着变。
  expect(within(members).queryByText('Primary')).not.toBeInTheDocument();
  await user.click(
    await within(members).findByRole(
      'button',
      { name: `Actions for ${memberName}` },
      SLOW,
    ),
  );
  await user.click(
    await screen.findByRole(
      'menuitem',
      { name: 'Make primary department' },
      SLOW,
    ),
  );
  expect(
    await within(members).findByText('Primary', undefined, SLOW),
  ).toBeVisible();
});

it('makes a member of a department its manager', async () => {
  const user = userEvent.setup();
  const suffix = unique();
  const rootTitle = `Root${suffix}`;
  const rootCode = `ROOT${suffix}`;
  const childTitle = `Child${suffix}`;
  const childCode = `CHILD${suffix}`;
  const memberName = `Alice${suffix}`;
  const memberUsername = `alice${suffix}`;

  await renderShared(<DepartmentsPage />, {
    route: '/settings/departments',
    prepare: async (_server: TestApp, session: TestSession) => {
      const { root } = await seedTree(
        session,
        rootTitle,
        rootCode,
        childTitle,
        childCode,
      );
      const member = await createUser(session, memberName, memberUsername);
      await addMembers(session, root.id, [member.id]);
    },
  });

  await user.click(await treeRow(rootTitle));
  const members = await screen.findByRole('region', { name: 'Members' }, SLOW);
  expect(
    await within(members).findByText(memberName, undefined, SLOW),
  ).toBeVisible();

  // 设为负责人。
  await user.click(
    await within(members).findByRole(
      'button',
      { name: `Actions for ${memberName}` },
      SLOW,
    ),
  );
  await user.click(
    await screen.findByRole('menuitem', { name: 'Make manager' }, SLOW),
  );
  // 树重读让详情按新的 updatedAt 重挂，所以每次在 waitFor 里重新取区域。
  await waitFor(
    () =>
      expect(
        within(
          screen.getByRole('region', { name: 'Department details' }),
        ).getByText(memberName),
      ).toBeVisible(),
    { timeout: 20_000 },
  );
  await waitFor(
    () =>
      expect(
        within(screen.getByRole('region', { name: 'Members' })).getAllByText(
          'Manager',
        ),
      ).toHaveLength(2),
    { timeout: 20_000 },
  );
});

it('deactivates an empty department', async () => {
  const user = userEvent.setup();
  const suffix = unique();
  const rootTitle = `Root${suffix}`;
  const rootCode = `ROOT${suffix}`;
  const childTitle = `Child${suffix}`;
  const childCode = `CHILD${suffix}`;

  await renderShared(<DepartmentsPage />, {
    route: '/settings/departments',
    prepare: async (_server: TestApp, session: TestSession) => {
      await seedTree(session, rootTitle, rootCode, childTitle, childCode);
    },
  });

  // 停用子部门：它空着，可以直接停用。详情切到子部门之后才能点它的按钮。
  await user.click(await treeRow(childTitle));
  await waitFor(
    () =>
      expect(
        within(
          screen.getByRole('region', { name: 'Department details' }),
        ).getByText(childTitle, { exact: true }),
      ).toBeVisible(),
    { timeout: 20_000 },
  );
  await user.click(
    within(
      await screen.findByRole('region', { name: 'Department details' }, SLOW),
    ).getByRole('button', { name: 'Deactivate' }),
  );
  const dialog = await screen.findByRole('dialog', undefined, SLOW);
  await user.click(within(dialog).getByRole('button', { name: 'Deactivate' }));
  await dialogClosed();
  await waitFor(
    () =>
      expect(
        within(
          within(
            screen.getByRole('navigation', { name: 'Department tree' }),
          ).getByRole('button', {
            name: new RegExp(`^${escape(childTitle)}`),
          }),
        ).getByText('Inactive'),
      ).toBeVisible(),
    SLOW,
  );
  expect(
    await screen.findByRole('button', { name: 'Activate' }, SLOW),
  ).toBeVisible();
});

it('refuses the page to a member without departments.view', async () => {
  await renderAuthenticatedClient(<DepartmentsPage />, {
    route: '/settings/departments',
    member: true,
    grants: [pageAccessGrant],
  });

  expect(
    await screen.findByText(
      'You cannot open department management',
      undefined,
      SLOW,
    ),
  ).toBeVisible();
  // 断言「不存在」：同步的 queryBy 保持原样。
  expect(
    screen.queryByRole('navigation', { name: 'Department tree' }),
  ).not.toBeInTheDocument();
});

it('shows no write control to a member who can view but not manage', async () => {
  const user = userEvent.setup();
  const suffix = unique();
  const title = `Readonly${suffix}`;
  const memberName = `Bob${suffix}`;

  await renderAuthenticatedClient(<DepartmentsPage />, {
    route: '/settings/departments',
    member: true,
    grants: [pageAccessGrant, viewGrant],
    prepare: async (server: TestApp) => {
      const admin = await signIn(server, DEFAULT_ADMIN_CREDENTIALS);
      const department = await createDepartment(admin, {
        title,
        code: `READ${suffix}`,
      });
      const member = await createUser(admin, memberName, `bob${suffix}`);
      await addMembers(admin, department.id, [member.id]);
    },
  });

  await user.click(await treeRow(title));
  const members = await screen.findByRole('region', { name: 'Members' }, SLOW);
  expect(
    await within(members).findByText(memberName, undefined, SLOW),
  ).toBeVisible();
  // 断言「不存在」：同步的 queryBy 保持原样。
  for (const name of [
    'New department',
    'Add members',
    'Save',
    'Deactivate',
    'Activate',
    'Merge into…',
  ]) {
    expect(
      screen.queryByRole('button', { name }),
      `${name} 不应当出现在只读页面上`,
    ).not.toBeInTheDocument();
  }
  expect(
    screen.queryByRole('button', { name: /^Actions for / }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
});

it('moves a batch of selected members to another department', async () => {
  const user = userEvent.setup();
  const suffix = unique();
  const fromTitle = `From${suffix}`;
  const toTitle = `To${suffix}`;
  const memberName = `Erin${suffix}`;

  await renderAuthenticatedClient(<DepartmentsPage />, {
    route: '/settings/departments',
    prepare: async (server: TestApp) => {
      const admin = await signIn(server, DEFAULT_ADMIN_CREDENTIALS);
      const from = await createDepartment(admin, {
        title: fromTitle,
        code: `FROM${suffix}`,
      });
      await createDepartment(admin, {
        title: toTitle,
        code: `TO${suffix}`,
      });
      const member = await createUser(admin, memberName, `erin${suffix}`);
      await addMembers(admin, from.id, [member.id]);
    },
  });

  await user.click(await treeRow(fromTitle));
  const members = await screen.findByRole('region', { name: 'Members' }, SLOW);
  expect(
    await within(members).findByText(memberName, undefined, SLOW),
  ).toBeVisible();
  await user.click(
    await within(members).findByRole(
      'checkbox',
      { name: `Select ${memberName}` },
      SLOW,
    ),
  );
  await user.click(
    await within(members).findByRole('combobox', { name: 'Move to' }, SLOW),
  );
  await user.click(
    await screen.findByRole(
      'option',
      { name: new RegExp(escape(toTitle)) },
      SLOW,
    ),
  );
  await user.click(
    await within(members).findByRole('button', { name: 'Move selected' }, SLOW),
  );
  await waitFor(
    () =>
      expect(
        within(screen.getByRole('region', { name: 'Members' })).queryByText(
          memberName,
        ),
      ).not.toBeInTheDocument(),
    { timeout: 20_000 },
  );

  // 目标部门能看到他：整批调动真的写进了成员关系。
  await user.click(await treeRow(toTitle));
  expect(
    await within(
      await screen.findByRole('region', { name: 'Members' }, SLOW),
    ).findByText(memberName, undefined, SLOW),
  ).toBeVisible();
});

it('explains what to do when removing the manager or naming a non-member the manager', async () => {
  const user = userEvent.setup();
  const suffix = unique();
  const title = `Reject${suffix}`;
  const managerName = `Carol${suffix}`;
  const outsiderName = `Dave${suffix}`;

  await renderAuthenticatedClient(<DepartmentsPage />, {
    route: '/settings/departments',
    prepare: async (server: TestApp) => {
      const admin = await signIn(server, DEFAULT_ADMIN_CREDENTIALS);
      const department = await createDepartment(admin, {
        title,
        code: `REJ${suffix}`,
      });
      const manager = await createUser(admin, managerName, `carol${suffix}`);
      await createUser(admin, outsiderName, `dave${suffix}`);
      await addMembers(admin, department.id, [manager.id]);
      await patchDepartment(admin, department.id, {
        managerId: manager.id,
      });
    },
  });

  await user.click(await treeRow(title));
  const members = await screen.findByRole('region', { name: 'Members' }, SLOW);
  expect(
    await within(members).findByText(managerName, undefined, SLOW),
  ).toBeVisible();

  // 移出负责人被拒：提示先换负责人。
  await user.click(
    await within(members).findByRole(
      'button',
      { name: `Actions for ${managerName}` },
      SLOW,
    ),
  );
  await user.click(
    await screen.findByRole(
      'menuitem',
      { name: 'Remove from department' },
      SLOW,
    ),
  );
  expect(
    await within(members).findByText(
      /Choose another manager first/,
      undefined,
      SLOW,
    ),
  ).toBeVisible();

  // 把非成员设为负责人被拒：提示先把他加为成员。
  const details = await screen.findByRole(
    'region',
    { name: 'Department details' },
    SLOW,
  );
  await user.type(within(details).getByLabelText('Manager'), outsiderName);
  await user.click(within(details).getByRole('button', { name: 'Search' }));
  await user.click(
    await within(details).findByRole(
      'button',
      { name: new RegExp(escape(outsiderName)) },
      SLOW,
    ),
  );
  await user.click(within(details).getByRole('button', { name: 'Save' }));
  expect(
    await within(details).findByText(
      /not a member of this department yet/,
      undefined,
      SLOW,
    ),
  ).toBeVisible();
  expect(document.body.textContent).not.toContain('@example.test');
});
