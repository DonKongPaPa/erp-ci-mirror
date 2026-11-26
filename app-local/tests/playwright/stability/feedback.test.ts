import { randomUUID } from 'node:crypto';

import { expect, test, type Locator, type Page } from '@playwright/test';

/**
 * 稳定性测试（R-026 验收 39）：反馈单的三个页面。
 *
 * 断言用户看得见的东西不动：列表骨架换成数据时表格容器不位移、切筛选时容器与行按钮
 * 不重挂；新建表单真的能填能提交；详情的字段能保存并被读回。前置是 APP_URL 指向
 * 运行中的应用，登录用户有维护权限（root 管理员）。失败时留下录像与 trace。
 */
const applicationUrl = process.env.APP_URL;
const basePath = process.env.APP_BASE_PATH ?? '/main';

test.skip(!applicationUrl, 'Set APP_URL to the running application entry.');

const origin = () => applicationUrl!.replace(/\/$/, '');
const feedbacksPath = () => `${origin()}${basePath}/feedbacks`;

async function signIn(page: Page): Promise<void> {
  const response = await page.request.post(
    `${origin()}${basePath}/api/auth/sign-in/email`,
    {
      data: {
        email: process.env.E2E_ADMIN_EMAIL ?? 'admin@nocobase.com',
        password: process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
      },
      headers: { origin: origin() },
    },
  );
  expect(response.ok(), `登录失败：${await response.text()}`).toBe(true);
}

/** 造一张自己的单，列表与详情才有真实的行可量。 */
async function seedFeedback(page: Page): Promise<string> {
  const response = await page.request.post(
    `${origin()}${basePath}/api/quality/feedbacks`,
    {
      headers: { origin: origin(), 'Idempotency-Key': `${Date.now()}.${randomUUID()}` },
      data: { channel: 'web', content: `稳定性测试 ${Date.now()}` },
    },
  );
  expect(response.ok(), `建单失败：${await response.text()}`).toBe(true);
  const payload = (await response.json()) as { data: { id: string } };
  return payload.data.id;
}

/** 列表重新取数的那一次请求：带 page 的 `/api/quality/feedbacks`，不是 `/mine` 或详情。 */
function isFeedbackListRequest(url: URL): boolean {
  return (
    url.pathname.endsWith('/api/quality/feedbacks') &&
    url.searchParams.has('page')
  );
}

async function delayList(page: Page, milliseconds: number): Promise<void> {
  await page.route(
    (url) => isFeedbackListRequest(url),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, milliseconds));
      await route.continue();
    },
  );
}

async function placement(locator: Locator) {
  const measured = await locator.boundingBox();
  expect(measured, '元素没有可量的矩形').not.toBeNull();
  return {
    width: Math.round(measured!.width * 10) / 10,
    x: Math.round(measured!.x * 10) / 10,
    y: Math.round(measured!.y * 10) / 10,
  };
}

async function mark(locator: Locator, marker: string): Promise<void> {
  await locator.evaluate(
    (element, value) => element.setAttribute('data-stability-marker', value),
    marker,
  );
}

const list = (page: Page) => page.locator('[data-testid="feedback-list"]');
const skeleton = (page: Page) =>
  page.locator('[data-testid="feedback-skeleton-row"]').first();
const rows = (page: Page) => page.locator('[data-testid="feedback-row"]');

test.describe('反馈单三个页面的稳定性', () => {
  test('骨架换成数据与切换筛选时容器不位移，行按钮还是同一个节点', async ({
    page,
  }) => {
    await signIn(page);
    await seedFeedback(page);
    await delayList(page, 800);
    await page.goto(feedbacksPath());

    await list(page).waitFor({ state: 'visible' });
    await skeleton(page).waitFor({ state: 'visible' });
    const firstPlacement = await placement(list(page));

    await skeleton(page).waitFor({ state: 'detached' });
    await rows(page).first().waitFor({ state: 'visible' });
    expect(await placement(list(page)), '骨架换成数据把表格顶走了').toEqual(
      firstPlacement,
    );

    const edit = rows(page)
      .first()
      .getByRole('button', { name: /Edit|编辑/ });
    await edit.waitFor({ state: 'visible' });
    await mark(edit, 'row-action');

    const pending = page.getByRole('button', { name: /Pending|待处理/ });
    const requested = page.waitForRequest((request) =>
      isFeedbackListRequest(new URL(request.url())),
    );
    const refetched = page.waitForResponse((response) =>
      isFeedbackListRequest(new URL(response.url())),
    );
    await pending.click();
    await requested;
    // 取数期间保留上一批数据行，容器停在原处（这一版切筛选不铺骨架）。
    expect(await placement(list(page)), '切筛选取数期间容器位移了').toEqual(
      firstPlacement,
    );
    await refetched;
    await page
      .locator('[data-stability-marker="row-action"]')
      .waitFor({ state: 'visible' });
    expect(
      await page.locator('[data-stability-marker="row-action"]').count(),
      '行按钮被卸载重装了',
    ).toBe(1);
  });

  test('新建表单填写后能提交，回到列表且新单在最上面', async ({ page }) => {
    await signIn(page);
    await page.goto(`${feedbacksPath()}/new`);

    const dialog = page.getByRole('dialog');
    const description = dialog.getByLabel(/Description|描述/);
    await description.waitFor({ state: 'visible' });
    const content = `稳定性提交尺寸超差 ${Date.now()}`;
    await description.fill(content);
    await dialog
      .getByRole('button', { name: /Submit feedback|提交反馈/ })
      .click();

    const toast = page.getByText(/Feedback submitted|反馈已提交/);
    await toast.waitFor({ state: 'visible' });
    await page.waitForURL(new RegExp(`${basePath}/feedbacks$`));
    const firstRow = rows(page).first();
    await firstRow.waitFor({ state: 'visible' });
    await expect(firstRow).toContainText(content);
  });

  test('详情编辑保存后读回仍是新值', async ({ page }) => {
    await signIn(page);
    const id = await seedFeedback(page);
    await page.goto(`${feedbacksPath()}/${id}`);

    const dialog = page.getByRole('dialog');
    const note = dialog.getByLabel(/^Note$|^备注$/);
    await note.waitFor({ state: 'visible' });
    const saved = `稳定性备注 ${Date.now()}`;
    await note.fill(saved);
    await dialog.getByRole('button', { name: /Save changes|保存修改/ }).click();

    const toast = page.getByText(/Changes saved|修改已保存/);
    await toast.waitFor({ state: 'visible' });

    await page.reload();
    const noteAgain = page.getByLabel(/^Note$|^备注$/);
    await noteAgain.waitFor({ state: 'visible' });
    await expect(noteAgain).toHaveValue(saved);
  });
});
