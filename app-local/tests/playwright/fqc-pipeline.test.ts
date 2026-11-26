import { randomUUID } from 'node:crypto';

import { expect, test } from '@playwright/test';

/**
 * FQC 链路的端到端整合测试：直接打真实 API，验证「客户消息 → 初筛」。
 *
 * 为什么不用浏览器点页面：这一档要验证的是**业务链路**是否成立，而不是像素。
 * 页面渲染由 client 单测覆盖；这里要证明的是服务端在真实运行的应用里能跑通全链路，
 * 且数据真的落库、能查回来。工单在人工确认草稿之后才建（R-003），不属于投递这一段。
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
  test('消息投递后服务端完成初筛，不直接建工单', async ({ request }) => {
    // 1) 投递一条典型缺陷描述。内容必须能命中规则关键词，否则初筛不会判成尺寸类。
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

    // R-003 定稿：201 的 data 只有 message 与 screening 两段，没有 ticket。
    // 字段类型照 server/routes/schemas.ts 的 IngestResultSchema / ScreeningSchema。
    const { data } = (await ingest.json()) as {
      data: {
        message: { id: string; content: string };
        screening: {
          id: string;
          messageId: string;
          category: string | null;
          severity: string | null;
          suggestedOwner: string | null;
          summary: string | null;
          confidence: string | null;
          evidence: unknown;
          modelName: string | null;
          engine: string;
          promptVersion: string | null;
          degraded: boolean;
          degradeReason: string | null;
          knowledgeRefs: string[] | null;
          redacted: boolean;
          reviewId: string | null;
          outcome: string;
          createdAt: string;
          updatedAt: string;
        };
      };
    };

    // 2) 原始消息必须原样留痕，AI 不改写客户原话。
    expect(data.message.content).toBe(
      '这批零件尺寸超差了，装配不上，公差差 0.3mm，已经停了产线',
    );

    // 3) 初筛已建，并且挂在这一条消息上 —— 不是只回了个临时对象。
    expect(data.screening.id).toBeTruthy();
    expect(data.screening.messageId).toBe(data.message.id);

    // 4) 结论按 schema：尺寸超差判成 dimension；严重度与 outcome 落在合法取值内，
    //    可空文本按列的形态给出（null 或字符串）。
    expect(data.screening.category).toBe('dimension');
    expect(['critical', 'major', 'minor', 'info']).toContain(
      data.screening.severity,
    );
    // schema 里 outcome 是 z.string()，没有枚举；R-003 的 auto→suggested 改名在后面的
    // 迁移片，当前主线仍会回 auto，所以两种都认，但不接受空串或任意值。
    expect(['auto', 'suggested', 'needs-review', 'reviewed']).toContain(
      data.screening.outcome,
    );
    expect(
      data.screening.confidence === null ||
        typeof data.screening.confidence === 'string',
    ).toBe(true);
    expect(
      data.screening.summary === null ||
        typeof data.screening.summary === 'string',
    ).toBe(true);
    expect(
      data.screening.suggestedOwner === null ||
        typeof data.screening.suggestedOwner === 'string',
    ).toBe(true);

    // 5) 出处按 schema：引擎、草稿与降级的来源列都在响应里，类型与可空性对齐。
    expect(typeof data.screening.engine).toBe('string');
    expect(data.screening.engine.length).toBeGreaterThan(0);
    expect(
      data.screening.promptVersion === null ||
        typeof data.screening.promptVersion === 'string',
    ).toBe(true);
    expect(
      data.screening.modelName === null ||
        typeof data.screening.modelName === 'string',
    ).toBe(true);
    expect(
      data.screening.degradeReason === null ||
        typeof data.screening.degradeReason === 'string',
    ).toBe(true);
    expect(typeof data.screening.degraded).toBe('boolean');
    expect(typeof data.screening.redacted).toBe('boolean');
    expect(Object.prototype.hasOwnProperty.call(data.screening, 'evidence')).toBe(
      true,
    );
    expect(
      data.screening.knowledgeRefs === null ||
        Array.isArray(data.screening.knowledgeRefs),
    ).toBe(true);
    expect(data.screening.reviewId).toBeNull();

    // 6) 守「投递不建单」：201 的 data 里整段没有 ticket 键（R-003 验收 1，PR #155 收口）。
    //    工单要等人工确认草稿之后才建，派单端点属于后面的切片，这里不碰。
    expect(data).not.toHaveProperty('ticket');

    // 7) 初筛真的落库：从初筛列表按 id 查回来，类别仍是 dimension。
    //    原来这里拿 ticket.id 查工单列表；投递不建工单，改查初筛列表。
    const list = await request.get(api('quality/screenings'), {
      params: { pageSize: '50' },
    });
    expect(list.status(), await list.text()).toBe(200);
    const listed = (await list.json()) as {
      data: Array<{ id: string; category: string | null }>;
    };
    const persisted = listed.data.find((row) => row.id === data.screening.id);
    expect(persisted, `初筛 ${data.screening.id} 未在列表中查回`).toBeDefined();
    expect(persisted?.category).toBe('dimension');
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
