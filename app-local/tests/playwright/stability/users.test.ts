import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 稳定性测试（R-039 第四道门）第一条：用户管理页。
 *
 * 在真实运行的应用里按脚本操作，断言用户看得见的东西不动：
 *   - 搜索框里输入再删除：表格容器与分页条的矩形不变；
 *   - 「操作」列的按钮是同一个 DOM 节点（重新取数没有把它卸载重装）；
 *   - 开着的确认框在列表重新取数之后仍然开着；
 *   - 首屏：加载占位被内容替换时，不能把视口里别的内容顶走。
 *
 * 为什么用矩形而不是布局位移分数：通行的 CLS 排除了输入之后 500 毫秒内的位移，而跳动
 * 恰好发生在这一段；修 F-002 时量到列宽抖 35 像素的几次，分数只有 0.003。矩形量的就是
 * 用户看到的（设计文档「理由」一节）。
 *
 * 前置：APP_URL 指向可访问的应用；登录用户要有用户管理的权限（默认 root 管理员）。
 * 失败时 Playwright 按 playwright.config.ts 留下录像与 trace。
 */
const applicationUrl = process.env.APP_URL;
const basePath = process.env.APP_BASE_PATH ?? '/main';

test.skip(!applicationUrl, 'Set APP_URL to the running application entry.');

const origin = () => applicationUrl!.replace(/\/$/, '');
const usersPath = () => `${origin()}${basePath}/settings/users`;

/** 列表重新取数的那一次请求：`/api/users?page=…`，而不是 `/api/users/options` 或详情。 */
function isUsersListRequest(url: URL): boolean {
  return url.pathname.endsWith('/api/users') && url.searchParams.has('page');
}

async function signIn(page: Page): Promise<void> {
  const response = await page.request.post(
    `${origin()}${basePath}/api/auth/sign-in/email`,
    {
      data: {
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@nocobase.com',
        password: process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
      },
      // cookie 鉴权的写操作会校验 Origin，脚本要显式带（fqc-pipeline.test.ts 同一约定）。
      headers: { origin: origin() },
    },
  );
  expect(response.ok(), `登录失败：${await response.text()}`).toBe(true);
}

/** 打开用户管理页，等第一批数据行落下来。加载占位也是一个 `tr`，所以等行里的操作按钮。 */
async function openUsers(page: Page): Promise<void> {
  await signIn(page);
  await page.goto(usersPath());
  await expect(page.locator('table')).toBeVisible();
  await expect(
    page.locator('tbody tr').first().getByRole('button'),
  ).toBeVisible();
}

/**
 * 让列表的每次取数慢一点，取数中的忙碌状态才量得到。
 *
 * 本机的开发服务器十几毫秒就答完了，输入到响应的窗口比一次断言轮询还短；这不是
 * 应用的问题，是测量需要。延迟只加在测试里，不动服务器的行为。
 */
async function delayUsersList(page: Page, milliseconds: number): Promise<void> {
  await page.route(
    (url) => isUsersListRequest(url),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      await route.continue();
    },
  );
}

/** 关键元素的矩形：用户看到的就是这几个数。 */
async function box(locator: Locator, label: string) {
  const measured = await locator.boundingBox();
  expect(measured, `${label} 没有可量的矩形`).not.toBeNull();
  return measured!;
}

const rounded = (rect: { x: number; y: number; width: number; height: number }) => ({
  height: Math.round(rect.height * 10) / 10,
  width: Math.round(rect.width * 10) / 10,
  x: Math.round(rect.x * 10) / 10,
  y: Math.round(rect.y * 10) / 10,
});

/** 只比位置与宽度：占位被内容替换时容器向下长高是应该的，被顶走不是。 */
const placement = (rect: { x: number; y: number; width: number }) => ({
  width: Math.round(rect.width * 10) / 10,
  x: Math.round(rect.x * 10) / 10,
  y: Math.round(rect.y * 10) / 10,
});

/** 表格容器：`table` 外面那层带边框的盒子。 */
const tableContainer = (page: Page) => page.locator('table').locator('xpath=..');
const tableFooter = (page: Page) => page.locator('[data-slot="data-table-footer"]');
/**
 * 搜索框。用 `data-slot` 而不是角色：确认框开着时页面被 `aria-hidden`，
 * 角色查询会等一个永远不可见的元素。
 */
const searchBox = (page: Page) => page.locator('input[data-slot="input"]').first();
const marked = (page: Page, marker: string) =>
  page.locator(`[data-stability-marker="${marker}"]`);

async function mark(locator: Locator, marker: string): Promise<void> {
  await locator.evaluate(
    (element, value) => element.setAttribute('data-stability-marker', value),
    marker,
  );
}

test.describe('用户管理页的稳定性', () => {
  test('搜索再删除时表格容器与分页条不动，操作按钮还是同一个节点', async ({
    page,
  }) => {
    await delayUsersList(page, 800);
    await openUsers(page);
    const container = tableContainer(page);
    const footer = tableFooter(page);
    const actions = page.locator('tbody tr').first().getByRole('button').first();
    const name = (
      await page.locator('tbody tr').first().locator('td').first().innerText()
    ).trim();
    expect(name.length, '第一行没有名字，无法搜索').toBeGreaterThan(0);
    await mark(actions, 'row-actions');
    // 未筛选的整张列表：清空之后必须回到这个位置。
    const unfiltered = {
      container: rounded(await box(container, '未筛选的表格容器')),
      footer: rounded(await box(footer, '未筛选的分页条')),
    };

    const search = searchBox(page);
    // 搜索这一行的名字：重新取数后这一行仍在，操作按钮才有「同一个节点」可言。
    const searching = page.waitForResponse((response) =>
      isUsersListRequest(new URL(response.url())),
    );
    await search.fill(name);
    // 取数期间保留上一批数据行：容器与分页条停在原处。这一段就是 F-002 的第一层：
    // 占位比数据高，分页条被顶下去 68 像素。先量矩形，失败信息里才有真实的位移数字。
    expect(
      rounded(await box(container, '搜索取数中的表格容器')),
      '搜索取数期间表格容器的矩形变了',
    ).toEqual(unfiltered.container);
    expect(
      rounded(await box(footer, '搜索取数中的分页条')),
      '搜索取数期间分页条的矩形变了',
    ).toEqual(unfiltered.footer);
    await expect(page.locator('table')).toHaveAttribute('aria-busy', 'true');
    await expect(marked(page, 'row-actions')).toHaveCount(1);

    await searching;
    await expect(page.locator('table')).toHaveAttribute('aria-busy', 'false');
    // 结果变少时分页条上移是应该的；这里只守「这一行还在、按钮还是同一个节点」。
    await expect(page.locator('tbody tr').first()).toContainText(name);
    await expect(marked(page, 'row-actions')).toHaveCount(1);
    const filtered = {
      container: rounded(await box(container, '筛选后的表格容器')),
      footer: rounded(await box(footer, '筛选后的分页条')),
    };

    // 再删掉搜索词：取数期间仍停在筛选后的位置，数据回来回到整张列表。
    const clearing = page.waitForResponse((response) =>
      isUsersListRequest(new URL(response.url())),
    );
    await search.fill('');
    await expect(page.locator('table')).toHaveAttribute('aria-busy', 'true');
    expect(
      rounded(await box(container, '清空取数中的表格容器')),
      '清空取数期间表格容器的矩形变了',
    ).toEqual(filtered.container);
    expect(
      rounded(await box(footer, '清空取数中的分页条')),
      '清空取数期间分页条的矩形变了',
    ).toEqual(filtered.footer);
    await expect(marked(page, 'row-actions')).toHaveCount(1);

    await clearing;
    await expect(page.locator('table')).toHaveAttribute('aria-busy', 'false');
    expect(
      rounded(await box(container, '清空完成后的表格容器')),
      '清空完成后没有回到整张列表的表格容器',
    ).toEqual(unfiltered.container);
    expect(
      rounded(await box(footer, '清空完成后的分页条')),
      '清空完成后没有回到整张列表的分页条',
    ).toEqual(unfiltered.footer);
    await expect(marked(page, 'row-actions')).toHaveCount(1);
  });

  test('列表重新取数时开着的确认框仍然开着', async ({ page }) => {
    await delayUsersList(page, 1500);
    await openUsers(page);
    const firstRow = page.locator('tbody tr').first();
    const name = (await firstRow.locator('td').first().innerText()).trim();
    const search = searchBox(page);
    const refetching = page.waitForResponse((response) =>
      isUsersListRequest(new URL(response.url())),
    );
    // 先让重新取数停在半路（弹层开着时页面是 inert，键盘输入不进来 —— 真实顺序是
    // 用户输入之后马上去点行操作，取数还在路上）。取数期间行还在，菜单打得开。
    await search.fill(name);
    await expect(page.locator('table')).toHaveAttribute('aria-busy', 'true');
    await firstRow.getByRole('button').first().click();
    await page.getByRole('menuitem').first().click();
    const dialog = page.getByRole('alertdialog');
    await expect(dialog).toBeVisible();
    await mark(dialog, 'confirm-dialog');

    await refetching;
    await expect(page.locator('table')).toHaveAttribute('aria-busy', 'false');
    // 取数完成、这一行还在，确认框就还是同一个节点、还开着。
    await expect(firstRow.locator('td').first()).toHaveText(name);
    await expect(marked(page, 'confirm-dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });

  test('首屏加载占位被内容替换时，视口里的别的内容不动', async ({ page }) => {
    // 让列表请求停在半路：先量占位状态下的位置，再放行。
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(
      (url) => isUsersListRequest(url),
      async (route) => {
        await held;
        await route.continue();
      },
    );
    await signIn(page);
    await page.goto(usersPath());
    const search = searchBox(page);
    const heading = page.getByRole('heading').first();
    await expect(search).toBeVisible();
    // 表格自己的加载占位（不是路由切换时的加载标记）。
    await expect(
      page.locator('table [data-slot="loading"]'),
    ).toBeVisible();
    const before = {
      heading: rounded(await box(heading, '页面标题')),
      search: rounded(await box(search, '搜索框')),
      table: placement(await box(tableContainer(page), '表格容器')),
    };

    release();
    await expect(
      page.locator('tbody tr').first().getByRole('button'),
    ).toBeVisible();
    await expect(page.locator('[data-slot="loading"]')).toHaveCount(0);
    // 上面量的三样在替换前后必须停在同一位置 —— 占位被内容替换不能把它们顶走。
    expect(
      rounded(await box(heading, '替换后的页面标题')),
      '首屏替换把页面标题顶走了',
    ).toEqual(before.heading);
    expect(
      rounded(await box(search, '替换后的搜索框')),
      '首屏替换把搜索框顶走了',
    ).toEqual(before.search);
    expect(
      placement(await box(tableContainer(page), '替换后的表格容器')),
      '首屏替换把表格容器顶走了',
    ).toEqual(before.table);
  });
});
