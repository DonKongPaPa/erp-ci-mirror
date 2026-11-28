// @vitest-environment node
import { describe, expect, it } from 'vitest';

import {
  buildFeedbackRequestBody,
  type FeedbackDraftInput,
} from '../../client/extensions/dev-feedback/model.js';
import { CreateSchema } from '../../server/dev-tools/feedback-schema.js';

/**
 * 面板组装的请求体必须过服务端真正的 zod 校验。#321 把接口模拟掉，假绿就是这个缺口。
 * 变异自检：把页面 target 的 route 改回 registryId，前两条用例必须红。
 */

const base: FeedbackDraftInput = {
  locate: 'page',
  route: '/items',
  element: null,
  registryId: '',
  text: '物料列表打开很慢',
  kinds: ['flow'],
  severe: false,
};

describe('反馈请求体契约', () => {
  it('页面定位：target 只有 kind 与 route，过服务端校验', () => {
    const body = buildFeedbackRequestBody(base);
    expect(body.target).toEqual({ kind: 'page', route: '/items' });
    expect(CreateSchema.safeParse(body).success).toBe(true);
  });

  it('页面定位变异：route 换成 registryId 必须过不了服务端校验', () => {
    const body = buildFeedbackRequestBody(base);
    const mutated = {
      ...body,
      target: {
        kind: 'page',
        registryId: (body.target as { route: string }).route,
      },
    };
    expect(CreateSchema.safeParse(mutated).success).toBe(false);
  });

  it('元素定位：target 只有 kind、text、locator 与可选 source，过服务端校验', () => {
    const withSource = buildFeedbackRequestBody({
      ...base,
      locate: 'element',
      element: {
        kind: 'element',
        text: '新建物料',
        locator: '[data-testid="item-new"]',
        source: 'client/pages/items/index.tsx:42',
      },
    });
    expect(Object.keys(withSource.target).sort()).toEqual([
      'kind',
      'locator',
      'source',
      'text',
    ]);
    expect(CreateSchema.safeParse(withSource).success).toBe(true);

    const withoutSource = buildFeedbackRequestBody({
      ...base,
      locate: 'element',
      element: {
        kind: 'element',
        text: '新建物料',
        locator: '[role="button"]',
      },
    });
    expect(Object.keys(withoutSource.target).sort()).toEqual([
      'kind',
      'locator',
      'text',
    ]);
    expect(CreateSchema.safeParse(withoutSource).success).toBe(true);
  });

  it('登记行定位：target 只有 kind 与 registryId，过服务端校验', () => {
    const body = buildFeedbackRequestBody({
      ...base,
      locate: 'registry',
      registryId: 'items',
    });
    expect(body.target).toEqual({ kind: 'registry', registryId: 'items' });
    expect(CreateSchema.safeParse(body).success).toBe(true);
  });

  it('顶层只带服务端认得的键，截图编号只在有截图时出现', () => {
    const noShot = buildFeedbackRequestBody(base);
    expect(Object.keys(noShot).sort()).toEqual([
      'kinds',
      'route',
      'severe',
      'target',
      'text',
    ]);
    const shot = buildFeedbackRequestBody({ ...base, screenshotId: 'att-1' });
    expect(Object.keys(shot).sort()).toEqual([
      'kinds',
      'route',
      'screenshotId',
      'severe',
      'target',
      'text',
    ]);
    expect(CreateSchema.safeParse(shot).success).toBe(true);
  });
});
