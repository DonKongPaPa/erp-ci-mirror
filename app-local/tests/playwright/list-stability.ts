import { expect, type Locator, type Page } from '@playwright/test';

/**
 * R-059：列表骨架换成数据时「用户看得见的东西不动」的统一量法。
 *
 * 客户端测试只能钉结构，这几件事只有真渲染量得出来（2026-11-26 两个列表页都栽在这里：
 * 员工页数据行 94.5px 对骨架行 39.6px、骨架态缺表头首行跳 51px；反馈单差 6px）。
 * helper 把请求延迟、量测与判定收在一处，两个页面各传自己的选择器即可。
 */
export interface ListRowsStabilityOptions {
  /** 页面地址；helper 在导航前装好 CLS 探针与取数延迟。 */
  readonly url: string;
  /** 列表区容器，骨架态与数据态共用同一个节点。 */
  readonly list: Locator;
  /** 列表区的选择器，给 CLS 探针用来判断位移是否落在列表里。 */
  readonly listSelector: string;
  /** 骨架行（至少两行）。 */
  readonly skeletonRows: Locator;
  /** 数据行（至少两行）。 */
  readonly dataRows: Locator;
  /** 表头行，骨架态与数据态都要在列表区里。 */
  readonly headerRow: Locator;
  /**
   * 列表区之外、紧邻其后的第一个持久节点（页脚 / 分页条 / 下一块内容）。
   * 行节点被整体替换不产生 layout-shift 条目，量这个节点的 y 才知道下方有没有被顶走。
   */
  readonly afterList: Locator;
  /**
   * 下方节点是否随行数变化移动：列表下方的分页条为 true；
   * 与列表并排的栅格面板为 false（它的 y 不随列表高度变）。
   */
  readonly afterListFollowsRows: boolean;
  /** 列表取数请求的判定，用来延迟以量到骨架态。 */
  readonly isListRequest: (url: URL) => boolean;
  /** 取数延迟毫秒，默认 800 —— 本机太快，不延迟量不到骨架。 */
  readonly delayMs?: number;
}

/** 亚像素四舍五入到 0.1px，避免浏览器小数抖动造成假红。 */
const px = (value: number): number => Math.round(value * 10) / 10;

async function box(locator: Locator, label: string) {
  const measured = await locator.boundingBox();
  expect(measured, `${label} 没有可量的矩形`).not.toBeNull();
  return measured!;
}

interface RowShape {
  readonly count: number;
  readonly firstHeight: number;
  readonly secondHeight: number;
  readonly firstY: number;
  readonly secondY: number;
  readonly headerY: number;
  readonly headerHeight: number;
  readonly afterY: number;
}

async function shape(
  options: ListRowsStabilityOptions,
  rows: Locator,
  state: string,
): Promise<RowShape> {
  await expect(rows.nth(0), `${state} 的第 1 行没出现`).toBeVisible({
    timeout: 15_000,
  });
  const count = await rows.count();
  expect(
    count,
    `${state} 不足两行，量不到第 2 行的位置`,
  ).toBeGreaterThanOrEqual(2);
  await expect(options.headerRow, `${state} 没有表头行`).toBeVisible();
  await expect(options.afterList, `${state} 列表下方没有持久节点`).toBeVisible();
  const first = await box(rows.nth(0), `${state} 第 1 行`);
  const second = await box(rows.nth(1), `${state} 第 2 行`);
  const header = await box(options.headerRow, `${state} 表头行`);
  const after = await box(options.afterList, `${state} 列表下方的持久节点`);
  return {
    count,
    firstHeight: px(first.height),
    secondHeight: px(second.height),
    firstY: px(first.y),
    secondY: px(second.y),
    headerY: px(header.y),
    headerHeight: px(header.height),
    afterY: px(after.y),
  };
}

/**
 * 真跑一次「骨架 → 数据」，断言四件事：
 *   1. 骨架行与数据行的行高差 0px（前两行各量一次）；
 *   2. 骨架态与数据态的表头行位置与高度一致；
 *   3. 数据到达前后第 1、2 行的 y 差 0px；
 *   4. 列表区之外、紧邻其后的持久节点（页脚 / 分页条）没有多余位移：扣掉行数变化的预期位移后，漂移 ≤ 1px。
 * CLS 只记录、不断言：被整体替换的行没有前一帧矩形，不产生 layout-shift 条目，
 * 只有列表区内留下来的节点位移才算，量不到「下方被顶走」（设计文档「理由」一节）。
 * 前置：调用方已登录；helper 自己装探针、延迟取数并导航。
 */
export async function expectListRowsStable(
  page: Page,
  options: ListRowsStabilityOptions,
): Promise<void> {
  // 探针必须在导航之前装好，否则骨架出现之前那几帧量不到。
  await page.addInitScript((selector: string) => {
    const state = { cls: 0 };
    Object.defineProperty(window, '__listStability', {
      value: state,
      configurable: true,
    });
    const observer = new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        const shift = entry as PerformanceEntry & {
          readonly hadRecentInput: boolean;
          readonly value: number;
          readonly sources?: readonly { readonly node?: Node }[];
        };
        if (shift.hadRecentInput) continue;
        const inList = (shift.sources ?? []).some(
          ({ node }) => node instanceof Element && Boolean(node.closest(selector)),
        );
        if (inList) state.cls += shift.value;
      }
    });
    observer.observe({ type: 'layout-shift', buffered: false });
  }, options.listSelector);

  await page.route(
    (url) => options.isListRequest(url),
    async (route) => {
      await new Promise((resolve) => setTimeout(resolve, options.delayMs ?? 800));
      await route.continue();
    },
  );

  await page.goto(options.url);
  await expect(options.list, '列表区没出现').toBeVisible({ timeout: 15_000 });
  await expect(options.skeletonRows.nth(0), '骨架行没出现').toBeVisible({
    timeout: 15_000,
  });
  const skeleton = await shape(options, options.skeletonRows, '骨架态');

  // 先等到数据真的到了再量：骨架还在时量到的是中间态。
  await expect(options.skeletonRows.nth(0), '骨架行没有退场').toBeHidden({
    timeout: 15_000,
  });
  const data = await shape(options, options.dataRows, '数据态');

  expect(skeleton.firstHeight, '骨架第 1 行与数据第 1 行不同高').toBe(
    data.firstHeight,
  );
  expect(skeleton.secondHeight, '骨架第 2 行与数据第 2 行不同高').toBe(
    data.secondHeight,
  );
  expect(skeleton.headerY, '骨架态与数据态表头行的 y 不同').toBe(data.headerY);
  expect(skeleton.headerHeight, '骨架态与数据态表头行不同高').toBe(
    data.headerHeight,
  );
  expect(skeleton.firstY, '数据到达后第 1 行跳了').toBe(data.firstY);
  expect(skeleton.secondY, '数据到达后第 2 行跳了').toBe(data.secondY);

  // 行数变化本身会把下方内容往下挪（反馈单骨架 8 行、数据一页 20 行），
  // 所以断言的是「扣掉行数变化后多出来的位移」——同一行数时就是 y 之差。
  const expectedShift = options.afterListFollowsRows
    ? (data.count - skeleton.count) * data.firstHeight
    : 0;
  const actualShift = data.afterY - skeleton.afterY;
  const drift = Math.abs(actualShift - expectedShift);
  expect(
    drift,
    `列表下方的持久节点被多顶了 ${drift}px（行数 ${skeleton.count}→${data.count}，预期位移 ${expectedShift}px，实际 ${actualShift}px）`,
  ).toBeLessThanOrEqual(1);

  // CLS 只记录供人看，不断言：替换掉的行不产生 layout-shift，量不到下方位移。
  const cls = await page.evaluate(() => {
    const state = (
      window as unknown as { __listStability?: { readonly cls: number } }
    ).__listStability;
    return state?.cls ?? -1;
  });
  console.log(
    `[list-stability] 列表区加载期 CLS=${cls < 0 ? '探针没装上' : cls}（只记录，不断言）`,
  );
}
