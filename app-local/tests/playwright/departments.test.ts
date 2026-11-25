import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * R-012 验收第 10 条：部门维护页在真实应用里走一遍 —— 建两个部门、加一个成员、
 * 设负责人、停用其中一个。
 *
 * 页面渲染与每种被拒的情况由 `tests/client/departments-page.test.tsx` 覆盖；
 * 这一档要证明的是：路由真的注册进了应用、真实服务器的授权与数据库都通、
 * 页面上的写按钮真的把数据写进去了。
 *
 * 用 APP_URL 指定运行中的应用（带 base path 由 APP_BASE_PATH 给出）。
 */
const applicationUrl = process.env.APP_URL;
const basePath = process.env.APP_BASE_PATH ?? '/main';

test.skip(!applicationUrl, 'Set APP_URL to the running application entry.');

const origin = (applicationUrl ?? '').replace(/\/$/, '');
const application = `${origin}${basePath}`;
const api = (path: string) => `${application}/api/${path}`;

const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 8);

const escape = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const writeHeaders = () => ({
  origin,
  'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
});

/** 用真实会话（cookie 存进浏览器上下文）；页面随后直接用这个会话打开。 */
async function signIn(page: Page): Promise<void> {
  const response = await page.request.post(api('auth/sign-in/email'), {
    data: {
      email: process.env.E2E_ADMIN_EMAIL ?? 'admin@nocobase.com',
      password: process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
    },
    headers: { origin },
  });
  expect(response.status(), `登录失败：${await response.text()}`).toBe(200);
}

/** 加成员要有一个用户；界面之外只建这一个账户，其余的都在页面上点。 */
async function createMember(page: Page, name: string, username: string) {
  const response = await page.request.post(api('users'), {
    data: {
      name,
      username,
      email: `${username}@example.test`,
      password: 'R012-dept-e2e-123!',
      roleScopes: { app: [] },
    },
    headers: writeHeaders(),
  });
  expect(response.status(), await response.text()).toBe(201);
}

/** 树的每一行：可访问名以部门名称开头；展开按钮的名称以 Expand 开头。 */
function treeRow(page: Page, title: string) {
  return page
    .getByRole('navigation', { name: 'Department tree' })
    .getByRole('button', { name: new RegExp(`^${escape(title)}`) });
}

async function createDepartment(
  page: Page,
  title: string,
  code: string,
): Promise<void> {
  await page.getByRole('button', { name: 'New department' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create a department' });
  await dialog.getByLabel('Name', { exact: true }).fill(title);
  await dialog.getByLabel('Code', { exact: true }).fill(code);
  await dialog.getByRole('button', { name: 'Create' }).click();
  await expect(dialog).toBeHidden();
  await expect(treeRow(page, title)).toBeVisible();
}

test('maintains the department tree through the page in the running application', async ({
  page,
}) => {
  const suffix = unique();
  const rootTitle = `Root${suffix}`;
  const childTitle = `Child${suffix}`;
  const memberName = `E2E${suffix}`;
  const memberUsername = `e2e${suffix}`;

  // 页面语言固定为英文，断言不依赖运行环境的账户偏好（真实的语言偏好存在账号上）。
  await signIn(page);
  const locale = await page.request.put(
    api('users/me/preferences/i18n.locale'),
    { data: { value: 'en-US' }, headers: { origin } },
  );
  expect(locale.status(), await locale.text()).toBe(200);
  await createMember(page, memberName, memberUsername);

  await page.goto(`${application}/settings/departments`);
  await expect(
    page.getByRole('heading', { name: 'Departments' }),
  ).toBeVisible();

  // 1) 建根部门与子部门。
  await createDepartment(page, rootTitle, `ROOT${suffix}`);
  await createDepartment(page, childTitle, `CHILD${suffix}`);

  // 2) 选中根部门，加一个成员。
  await treeRow(page, rootTitle).click();
  await page.getByRole('button', { name: 'Add members' }).click();
  const addDialog = page.getByRole('dialog', { name: 'Add members' });
  await addDialog.getByRole('textbox', { name: 'Search' }).fill(memberName);
  await addDialog.getByRole('button', { name: 'Search' }).click();
  await addDialog
    .getByRole('checkbox', { name: new RegExp(escape(memberName)) })
    .click();
  await addDialog.getByRole('button', { name: 'Add selected' }).click();
  await expect(addDialog).toBeHidden();

  const members = page.getByRole('region', { name: 'Members' });
  await expect(members.getByText(memberName, { exact: true })).toBeVisible();
  await expect(
    members.getByText(memberUsername, { exact: true }),
  ).toBeVisible();
  // 成员区不回邮箱。
  await expect(members).not.toContainText('@example.test');

  // 3) 设为负责人。
  await members
    .getByRole('button', { name: `Actions for ${memberName}` })
    .click();
  await page.getByRole('menuitem', { name: 'Make manager' }).click();
  const details = page.getByRole('region', { name: 'Department details' });
  await expect(details.getByText(memberName, { exact: true })).toBeVisible();

  // 4) 停用空着的子部门，树上带停用标记。
  await treeRow(page, childTitle).click();
  await details.getByRole('button', { name: 'Deactivate' }).click();
  const deactivateDialog = page.getByRole('dialog', {
    name: 'Deactivate department',
  });
  await deactivateDialog.getByRole('button', { name: 'Deactivate' }).click();
  await expect(deactivateDialog).toBeHidden();
  await expect(treeRow(page, childTitle).getByText('Inactive')).toBeVisible();
  await expect(details.getByRole('button', { name: 'Activate' })).toBeVisible();
});
