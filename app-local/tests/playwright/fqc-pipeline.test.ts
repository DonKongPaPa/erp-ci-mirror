import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

/**
 * FQC 链路的端到端整合测试：直接打真实 API，验证「客户消息 → 初筛 → 派单」。
 *
 * 为什么不用浏览器点页面：这一档要验证的是**业务链路**是否成立，而不是像素。
 * 页面渲染由 client 单测覆盖；这里要证明的是服务端在真实运行的应用里能跑通全链路，
 * 且数据真的落库、能查回来。
 *
 * 前置：目标应用必须可访问；登录用户要有 quality 端点的业务授权（默认管理员是 root，全部放行）。
 * 用 APP_URL 指定，例如 APP_URL=http://127.0.0.1:13000。
 */
const applicationUrl = process.env.APP_URL;
const basePath = process.env.APP_BASE_PATH ?? '/main';

test.skip(!applicationUrl, 'Set APP_URL to the running application entry.');

const api = (path: string) =>
  `${applicationUrl?.replace(/\/$/, '')}${basePath}/api/${path}`;

// cookie 鉴权的写操作会校验 Origin，缺了就 403 INVALID_CSRF_ORIGIN。
// 这不是测试环境的怪癖，是真实防护：浏览器会自动带 Origin，脚本必须显式带。
const writeHeaders = { origin: applicationUrl ?? '' };

/** 投递要求 Idempotency-Key；每个请求一个新键，免得后一次被当成前一次的重放。 */
const intakeHeaders = () => ({
  ...writeHeaders,
  'Idempotency-Key': `${Date.now()}.${randomUUID()}`,
});

/**
 * 质量端点先过登录校验再走授权（见 server/routes/quality.ts），
 * 所以整合测试必须先真实登录，用真实会话 cookie 打接口 —— 这正是它区别于单测的地方。
 */
test.beforeEach(async ({ request }) => {
  const signIn = await request.post(api('auth/sign-in/email'), {
    data: {
      email: process.env.E2E_ADMIN_EMAIL ?? 'admin@nocobase.com',
      password: process.env.E2E_ADMIN_PASSWORD ?? 'admin123',
    },
    headers: writeHeaders,
  });
  expect(signIn.status(), `登录失败：${await signIn.text()}`).toBe(200);
});

test.describe('FQC 客户反馈链路', () => {
  test('消息投递后服务端完成初筛并生成可查询的工单', async ({ request }) => {
    // 1) 投递一条典型缺陷描述。内容必须能命中规则关键词，否则不会自动派单。
    const ingest = await request.post(api('quality/intake'), {
      data: {
        channel: 'wechat',
        senderName: '整合测试客户',
        contentType: 'text',
        content: '这批零件尺寸超差了，装配不上，公差差 0.3mm，已经停了产线',
      },
      headers: intakeHeaders(),
    });
    expect(ingest.status(), await ingest.text()).toBe(201);

    const { data } = (await ingest.json()) as {
      data: {
        message: { id: string; content: string };
        screening: {
          category: string | null;
          severity: string | null;
          outcome: string;
        };
        ticket: {
          id: string;
          code: string;
          state: string;
          ownerDepartment: string | null;
        };
      };
    };

    // 2) 原始消息必须原样留痕，AI 不改写客户原话。
    expect(data.message.content).toBe(
      '这批零件尺寸超差了，装配不上，公差差 0.3mm，已经停了产线',
    );

    // 3) 初筛给出分类与严重度，并落在合法枚举内。
    expect([
      'appearance',
      'dimension',
      'function',
      'packaging',
      'material',
      'process',
      'other',
    ]).toContain(data.screening.category);
    expect(['critical', 'major', 'minor', 'info']).toContain(
      data.screening.severity,
    );

    // 4) 「尺寸超差」应被判为尺寸类缺陷并派给对应部门。
    expect(data.screening.category).toBe('dimension');
    expect(data.ticket.ownerDepartment).toBe('quality-dimension');

    // 5) 工单是新建的待处理状态，且有可读编号。
    expect(data.ticket.state).toBe('open');
    expect(data.ticket.code).toMatch(/^FQC-/u);

    // 6) 工单能通过列表接口查回来 —— 证明真的落库，不是只回了个对象。
    const list = await request.get(api('quality/tickets'), {
      params: { pageSize: '50' },
    });
    expect(list.status(), await list.text()).toBe(200);
    const listed = (await list.json()) as { data: Array<{ id: string }> };
    expect(listed.data.map((row) => row.id)).toContain(data.ticket.id);
  });

  test('无明确缺陷特征的消息不自动派单，转人工复核', async ({ request }) => {
    const ingest = await request.post(api('quality/intake'), {
      data: {
        channel: 'wechat',
        senderName: '整合测试客户',
        contentType: 'text',
        content: '在吗？问个事',
      },
      headers: intakeHeaders(),
    });
    expect(ingest.status(), await ingest.text()).toBe(201);

    const { data } = (await ingest.json()) as {
      data: { screening: { outcome: string; confidence: number | null } };
    };

    // 命中不了关键词时必须交给人，而不是硬猜一个分类派下去。
    expect(data.screening.outcome).toBe('needs-review');
  });
});
