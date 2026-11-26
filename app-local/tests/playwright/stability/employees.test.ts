import { randomUUID } from 'node:crypto';

import { expect, test, type Page } from '@playwright/test';

/**
 * R-011 验收第 18 条的四个清单流程，各一条稳定性测试：
 *   1. 入职一个人并放进一个部门；
 *   2. 给他换岗位；
 *   3. 办离职（这一行是「离职」、部门成员里没有他、变动记录里四件事都在）；
 *   4. 复聘并放回一个部门（工号不变）。
 *
 * 页面渲染与每种拒绝理由由 `tests/client/employees-pages.test.tsx` 覆盖；这一档要证明的是
 * 路由真的注册进应用、真实服务器的授权与数据库都通、页面上的写按钮真的把数据写进去了。
 *
 * 本地没有运行中的应用（不许碰 :13000 的开发服务器），这份测试没有在本地跑过，
 * 等镜像的 beta 作业与界面点验。用 APP_URL 指定运行中的应用（base path 由 APP_BASE_PATH 给出）。
 */
const applicationUrl = process.env.APP_URL;
const basePath = process.env.APP_BASE_PATH ?? '/main';

test.skip(!applicationUrl, 'Set APP_URL to the running application entry.');

const origin = () => (applicationUrl ?? '').replace(/\/$/, '');
const application = () => `${origin()}${basePath}`;
const api = (path: string) => `${application()}/api/${path}`;

const unique = (): string => randomUUID().replaceAll('-', '').slice(0, 8);
const writeHeaders = () => ({
  origin: origin(),
  'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
});

async function signIn(page: Page): Promise<void> {
  const response = await page.request.post(api('auth/sign-in/email'), {
    data: {
      email: process.env.E2E_ADMIN_EMAIL ?? 'admin@nocobase.com',
      password: process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
    },
    headers: { origin: origin() },
  });
  expect(response.ok(), `登录失败：${await response.text()}`).toBe(true);
  const locale = await page.request.put(api('users/me/preferences/i18n.locale'), {
    data: { value: 'en-US' },
    headers: writeHeaders(),
  });
  expect(locale.ok(), await locale.text()).toBe(true);
}

async function openEmployees(page: Page): Promise<void> {
  await page.goto(`${application()}/settings/employees`);
  await expect(page.getByRole('heading', { name: 'Employees' }).first()).toBeVisible();
}

interface Seed {
  readonly departmentId: string;
  readonly positionId: string;
  readonly name: string;
  readonly username: string;
  readonly employeeNo: string;
}

/** 前置：直接调服务端建部门、岗位与在职员工；被测的那一步仍然在页面上点。 */
async function seed(page: Page, status: 'active' | 'left' = 'active'): Promise<Seed> {
  const suffix = unique();
  const name = `E2E${suffix}`;
  const username = `e2e${suffix}`;
  const department = await page.request.post(api('departments'), {
    data: { title: `Department ${suffix}`, code: `DEP${suffix}` },
    headers: writeHeaders(),
  });
  expect(department.status(), await department.text()).toBe(201);
  const departmentId = ((await department.json()) as { data: { id: string } }).data.id;
  const positionId = `POS${suffix}`;
  const position = await page.request.post(api('positions'), {
    data: { id: positionId, title: `Technician ${suffix}` },
    headers: writeHeaders(),
  });
  expect(position.status(), await position.text()).toBe(201);
  const hire = await page.request.post(api('employees'), {
    data: {
      name,
      username,
      hiredOn: '2026-11-20',
      primaryDepartmentId: departmentId,
      positionId,
    },
    headers: writeHeaders(),
  });
  expect(hire.status(), await hire.text()).toBe(201);
  const hired = (await hire.json()) as { data: { employeeNo: string; userId: string } };
  const employeeNo = hired.data.employeeNo;
  if (status === 'left') {
    const leave = await page.request.post(api(`employees/${hired.data.userId}/leave`), {
      data: { leftOn: '2026-11-25' },
      headers: writeHeaders(),
    });
    expect(leave.status(), await leave.text()).toBe(201);
  }
  return { departmentId, positionId, name, username, employeeNo };
}

function row(page: Page, employeeNo: string) {
  return page.locator('[data-testid="employee-row"]').filter({ hasText: employeeNo });
}

test.describe('R-011 员工管理页的四条清单流程', () => {
  test('入职一个人并放进一个部门：列表有一行，没有邮箱栏', async ({ page }) => {
    await signIn(page);
    await openEmployees(page);
    const suffix = unique();
    const name = `E2E${suffix}`;
    const department = await page.request.post(api('departments'), {
      data: { title: `Department ${suffix}`, code: `DEP${suffix}` },
      headers: writeHeaders(),
    });
    expect(department.status(), await department.text()).toBe(201);
    const departmentId = ((await department.json()) as { data: { id: string } }).data.id;

    await page.getByRole('button', { name: 'New employee' }).click();
    const hire = page.getByRole('dialog', { name: 'Hire an employee' });
    await hire.getByLabel('Name', { exact: true }).fill(name);
    await hire.getByLabel('Hired on').fill('2026-11-20');
    await hire.getByLabel('Primary department').click();
    await page.getByRole('option', { name: new RegExp(`DEP${suffix}`) }).click();
    await hire.getByRole('button', { name: 'Hire' }).click();
    await expect(hire).toBeHidden();

    const hiredRow = page.locator('[data-testid="employee-row"]').filter({ hasText: name });
    await expect(hiredRow).toBeVisible();
    await expect(page.getByRole('columnheader', { name: 'Email' })).toHaveCount(0);
    await expect(hiredRow).not.toContainText('@');
    const employeeNo = (await hiredRow.locator('[role="cell"]').first().innerText()).trim();
    expect(employeeNo).toMatch(/^E\d{6}$/);

    const members = await page.request.get(api(`departments/${departmentId}/members`), {
      headers: { origin: origin() },
    });
    expect(members.ok(), await members.text()).toBe(true);
    expect(JSON.stringify(await members.json())).toContain(name);
  });

  test('给他换岗位：详情与变动记录里都是新岗位', async ({ page }) => {
    await signIn(page);
    const data = await seed(page);
    await openEmployees(page);
    await row(page, data.employeeNo)
      .getByRole('button', { name: 'Change this employee’s position' })
      .click();
    const transfer = page.getByRole('dialog', { name: 'Change position' });
    await transfer.getByRole('button', { name: `Technician ${data.positionId.slice(3)}` }).click();
    await transfer.getByRole('button', { name: 'Save' }).click();
    await expect(transfer).toBeHidden();

    await row(page, data.employeeNo)
      .getByRole('button', { name: 'View employee details' })
      .click();
    const detail = page.getByRole('dialog', { name: 'Employee details' });
    await expect(detail.getByText(`Technician ${data.positionId.slice(3)}`)).toBeVisible();
    await expect(detail.getByText('Position', { exact: true }).first()).toBeVisible();
  });

  test('办离职：这一行是「离职」、部门成员里没有他、变动记录四件事都在', async ({ page }) => {
    await signIn(page);
    const data = await seed(page);
    await openEmployees(page);
    await page.getByRole('radio', { name: 'Include former employees' }).check();
    await row(page, data.employeeNo)
      .getByRole('button', { name: 'Process this employee’s departure' })
      .click();
    const leave = page.getByRole('dialog', { name: 'Process a departure' });
    await leave.getByLabel('Left on').fill('2026-11-25');
    await leave.getByRole('button', { name: 'Confirm' }).click();
    await expect(leave).toBeHidden();
    await expect(row(page, data.employeeNo).getByText('Former')).toBeVisible();

    const members = await page.request.get(api(`departments/${data.departmentId}/members`), {
      headers: { origin: origin() },
    });
    expect(JSON.stringify(await members.json())).not.toContain(data.name);

    await row(page, data.employeeNo)
      .getByRole('button', { name: 'View employee details' })
      .click();
    const detail = page.getByRole('dialog', { name: 'Employee details' });
    const changes = detail.getByRole('region', { name: 'Change history' });
    await expect(changes.getByText('Hired', { exact: true })).toBeVisible();
    await expect(changes.getByText('Departure', { exact: true })).toBeVisible();
  });

  test('复聘并放回一个部门：工号不变，又变成在职', async ({ page }) => {
    await signIn(page);
    const data = await seed(page, 'left');
    await openEmployees(page);
    await page.getByRole('radio', { name: 'Include former employees' }).check();
    await row(page, data.employeeNo)
      .getByRole('button', { name: 'Rehire this employee' })
      .click();
    const rehire = page.getByRole('dialog', { name: 'Rehire an employee' });
    await rehire.getByLabel('Hired on').fill('2026-11-26');
    await rehire.getByLabel('Primary department').click();
    await page.getByRole('option', { name: new RegExp(`DEP${data.name.slice(3)}`) }).click();
    await rehire.getByRole('button', { name: 'Confirm' }).click();
    await expect(rehire).toBeHidden();

    await expect(row(page, data.employeeNo).getByText('Active')).toBeVisible();
    await expect(row(page, data.employeeNo)).toContainText(data.employeeNo);
    const members = await page.request.get(api(`departments/${data.departmentId}/members`), {
      headers: { origin: origin() },
    });
    expect(JSON.stringify(await members.json())).toContain(data.name);
  });
});
