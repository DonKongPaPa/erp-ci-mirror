import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import FeedbackPage from '../../client/extensions/dev-feedback/index.js';
import FeedbackPanel from '../../client/extensions/dev-feedback/panel.js';
import {
  buildFeedbackRequestBody,
  daysSince,
  locateElement,
  type FeedbackSnapshot,
} from '../../client/extensions/dev-feedback/model.js';
import { CreateSchema } from '../../server/dev-tools/feedback-schema.js';
import { buildSnapshot } from '../../server/dev-tools/feedback.js';
import {
  FIXTURE_ITEMS,
  FIXTURE_REGISTRY,
  FIXTURE_STATE,
} from '../fixtures/feedback.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * 验收第 3、7 条：两个视图各三条（分列、筛选、追加说明后出现；分组、搜索、折叠）；
 * 面板只用键盘提交、截图粘贴、类型与严重可选；点选元素的源文件行号先实测，取不到就退回定位信息。
 */

const snapshot: FeedbackSnapshot = buildSnapshot(
  FIXTURE_REGISTRY,
  FIXTURE_STATE,
  '2026-11-28T08:00:00+08:00',
);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withNote(
  origin: FeedbackSnapshot,
  id: string,
  text: string,
): FeedbackSnapshot {
  return {
    ...origin,
    items: origin.items.map((item) =>
      item.id === id
        ? {
            ...item,
            notes: [...item.notes, { text, at: '2026-11-28T09:00:00+08:00' }],
          }
        : item,
    ),
  };
}

async function renderPage(initial: FeedbackSnapshot) {
  let current = initial;
  return await renderAuthenticatedClient(<FeedbackPage />, {
    route: '/dev/feedback',
    afterResponse: async (request, response) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname.endsWith('/dev/feedback')) {
        return json(current);
      }
      const note = /\/dev\/feedback\/([^/]+)\/notes$/u.exec(pathname);
      if (request.method === 'POST' && note) {
        const body = (await request.clone().json()) as { text: string };
        current = withNote(current, note[1] ?? '', body.text);
        return json(current, 201);
      }
      if (
        request.method === 'POST' &&
        pathname.endsWith('/dev/feedback/seen')
      ) {
        const body = (await request.clone().json()) as { registryId: string };
        const at = '2026-11-28T09:00:00+08:00';
        current = {
          ...current,
          seen: { ...current.seen, [body.registryId]: at },
        };
        return json({ data: { registryId: body.registryId, at } }, 201);
      }
      return response;
    },
  });
}

describe('反馈视图用夹具渲染', () => {
  it('五种状态各成一列，条目落在自己的列里', async () => {
    await renderPage(snapshot);
    expect(
      await screen.findByTestId('feedback-columns', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    for (const status of ['new', 'accepted', 'fixed', 'wontfix', 'duplicate']) {
      expect(
        screen.getByTestId(`feedback-column-${status}`),
      ).toBeInTheDocument();
    }
    expect(
      within(screen.getByTestId('feedback-column-new')).getByTestId(
        'feedback-card-FB-001',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('feedback-column-fixed')).getByTestId(
        'feedback-card-FB-003',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('feedback-column-new')).queryByTestId(
        'feedback-card-FB-003',
      ),
    ).not.toBeInTheDocument();
  });

  it('按状态筛选后只剩一列有条目', async () => {
    await renderPage(snapshot);
    await screen.findByTestId('feedback-columns', {}, { timeout: 15_000 });
    const user = userEvent.setup();
    const trigger = screen.getByLabelText('Filter by status');
    await user.click(trigger);
    const options = await screen.findAllByRole(
      'option',
      {},
      { timeout: 15_000 },
    );
    const fixed = options.find((option) => option.textContent === 'Fixed');
    expect(fixed).toBeDefined();
    await user.click(fixed!);
    await waitFor(() => {
      expect(
        within(screen.getByTestId('feedback-column-new')).queryByTestId(
          'feedback-card-FB-001',
        ),
      ).not.toBeInTheDocument();
    });
    expect(
      within(screen.getByTestId('feedback-column-fixed')).getByTestId(
        'feedback-card-FB-003',
      ),
    ).toBeInTheDocument();
  });

  it('追加说明后出现，且原文不变', async () => {
    await renderPage(snapshot);
    await screen.findByTestId('feedback-columns', {}, { timeout: 15_000 });
    fireEvent.click(screen.getByTestId('feedback-card-FB-001'));
    const detail = await screen.findByTestId(
      'detail-FB-001',
      {},
      { timeout: 15_000 },
    );
    fireEvent.change(within(detail).getByRole('textbox'), {
      target: { value: '补充一句' },
    });
    fireEvent.click(within(detail).getByRole('button', { name: 'Add' }));
    expect(
      await within(detail).findByText('补充一句', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    expect(detail).toHaveTextContent(FIXTURE_ITEMS[0]!.text);
  });
});

describe('功能登记视图用夹具渲染', () => {
  it('有反馈、看过没意见、未反馈三组分开，未反馈显示天数', async () => {
    await renderPage({
      ...snapshot,
      registry: [
        ...snapshot.registry,
        {
          id: 'warehouses',
          module: '库存',
          page: 'warehouses',
          feature: '页面主体',
          route: '/warehouses',
          source: 'client/pages/warehouses/index.tsx',
          status: 'unfeedbacked',
          betaAt: '2026-11-20T00:00:00+08:00',
        },
      ],
    });
    fireEvent.click(
      await screen.findByTestId('tab-registry', {}, { timeout: 15_000 }),
    );
    expect(
      await screen.findByTestId(
        'registry-group-feedbacked',
        {},
        { timeout: 15_000 },
      ),
    ).toBeInTheDocument();
    expect(screen.getByTestId('registry-group-seen')).toBeInTheDocument();
    expect(
      screen.getByTestId('registry-group-unfeedbacked'),
    ).toBeInTheDocument();
    // 服务端快照里的 seen 决定分组：items 有反馈、shifts 看过没意见、warehouses 未反馈。
    expect(
      within(screen.getByTestId('registry-group-feedbacked')).getByTestId(
        'registry-row-items',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('registry-group-seen')).getByTestId(
        'registry-row-shifts',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByTestId('registry-group-unfeedbacked')).getByTestId(
        'registry-row-warehouses',
      ),
    ).toBeInTheDocument();
    // 天数按页面用的同一时钟算；写死「8 天」会在跨日之后变成假红。
    const betaAt = '2026-11-20T00:00:00+08:00';
    expect(screen.getByTestId('registry-group-unfeedbacked')).toHaveTextContent(
      `${daysSince(betaAt)} days since beta`,
    );
  });

  it('搜索把不匹配的模块折叠掉', async () => {
    await renderPage(snapshot);
    fireEvent.click(
      await screen.findByTestId('tab-registry', {}, { timeout: 15_000 }),
    );
    await screen.findByTestId(
      'registry-group-feedbacked',
      {},
      { timeout: 15_000 },
    );
    fireEvent.change(screen.getByLabelText('Search module, page or feature'), {
      target: { value: '人力' },
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId('registry-row-items'),
      ).not.toBeInTheDocument();
    });
    expect(screen.getByTestId('registry-row-partners')).toBeInTheDocument();
  });

  it('「看过，没意见」把行从未反馈移到看过组', async () => {
    await renderPage({
      ...snapshot,
      registry: [
        ...snapshot.registry,
        {
          id: 'warehouses',
          module: '库存',
          page: 'warehouses',
          feature: '页面主体',
          route: '/warehouses',
          source: 'client/pages/warehouses/index.tsx',
          status: 'unfeedbacked',
          betaAt: '',
        },
      ],
    });
    fireEvent.click(
      await screen.findByTestId('tab-registry', {}, { timeout: 15_000 }),
    );
    await screen.findByTestId(
      'registry-group-unfeedbacked',
      {},
      { timeout: 15_000 },
    );
    const row = screen.getByTestId('registry-row-warehouses');
    fireEvent.click(within(row).getByTestId('registry-seen-warehouses'));
    await waitFor(() => {
      expect(
        within(screen.getByTestId('registry-group-seen')).getByTestId(
          'registry-row-warehouses',
        ),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByTestId('registry-group-unfeedbacked'),
    ).not.toBeInTheDocument();
  });

  it('页面以端点返回为准，请求体不夹带 seen', async () => {
    const at = '2026-11-28T10:00:00+08:00';
    let current: FeedbackSnapshot = {
      ...snapshot,
      registry: [
        ...snapshot.registry,
        {
          id: 'warehouses',
          module: '库存',
          page: 'warehouses',
          feature: '页面主体',
          route: '/warehouses',
          source: 'client/pages/warehouses/index.tsx',
          status: 'unfeedbacked',
          betaAt: '',
        },
      ],
    };
    const posted: readonly { path: string; body: Record<string, unknown> }[] =
      [];
    const seenBodies: Record<string, unknown>[] = [];
    await renderAuthenticatedClient(<FeedbackPage />, {
      route: '/dev/feedback',
      afterResponse: async (request, response) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'GET' && pathname.endsWith('/dev/feedback')) {
          return json(current);
        }
        if (
          request.method === 'POST' &&
          pathname.endsWith('/dev/feedback/seen')
        ) {
          const body = (await request.clone().json()) as Record<
            string,
            unknown
          >;
          seenBodies.push(body);
          current = {
            ...current,
            seen: { ...current.seen, [String(body.registryId)]: at },
          };
          return json({ data: { registryId: body.registryId, at } }, 201);
        }
        if (request.method === 'POST') {
          posted.push({
            path: pathname,
            body: (await request.clone().json()) as Record<string, unknown>,
          });
        }
        return response;
      },
    });

    fireEvent.click(
      await screen.findByTestId('tab-registry', {}, { timeout: 15_000 }),
    );
    await screen.findByTestId(
      'registry-group-unfeedbacked',
      {},
      { timeout: 15_000 },
    );
    expect(
      within(screen.getByTestId('registry-group-unfeedbacked')).getByTestId(
        'registry-row-warehouses',
      ),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByTestId('registry-seen-warehouses'));
    await waitFor(() => {
      expect(
        within(screen.getByTestId('registry-group-seen')).getByTestId(
          'registry-row-warehouses',
        ),
      ).toBeInTheDocument();
    });
    // 只有显式的 seen 端点被写；它的请求体只有 registryId，没有任何 seen 映射夹带。
    expect(seenBodies).toEqual([{ registryId: 'warehouses' }]);
    for (const entry of [...posted, ...seenBodies]) {
      expect(entry).not.toHaveProperty('seen');
    }
  });
});

describe('悬浮反馈面板', () => {
  it('只靠打字加 Ctrl+Enter 就能提交，面板随后关闭', async () => {
    let posted: Record<string, unknown> | null = null;
    await renderAuthenticatedClient(<FeedbackPanel />, {
      route: '/items',
      afterResponse: async (request, response) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'GET' && pathname.endsWith('/dev/feedback')) {
          return json(snapshot);
        }
        if (request.method === 'POST' && pathname.endsWith('/dev/feedback')) {
          posted = (await request.clone().json()) as Record<string, unknown>;
          return json({ id: 'FB-006' }, 201);
        }
        return response;
      },
    });
    const panel = await screen.findByTestId(
      'dev-feedback-panel',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(panel).getByTestId('dev-feedback-open'));
    const text = await within(panel).findByTestId(
      'dev-feedback-text',
      {},
      { timeout: 15_000 },
    );
    fireEvent.change(text, { target: { value: '物料列表打开很慢' } });
    fireEvent.keyDown(text, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 15_000 });
    expect(posted).toMatchObject({ text: '物料列表打开很慢' });
    expect(posted?.target).toMatchObject({ kind: 'page' });
    await waitFor(() => {
      expect(screen.queryByTestId('dev-feedback-text')).not.toBeInTheDocument();
    });
  });

  it('点选元素退回文字与定位信息，取不到源文件行号时不编造', async () => {
    await renderAuthenticatedClient(
      <div>
        <FeedbackPanel />
        <button data-testid='probe-button' type='button'>
          新建物料
        </button>
      </div>,
      { route: '/items' },
    );
    const panel = await screen.findByTestId(
      'dev-feedback-panel',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(panel).getByTestId('dev-feedback-open'));
    fireEvent.click(
      await within(panel).findByTestId(
        'dev-feedback-locate-element',
        {},
        { timeout: 15_000 },
      ),
    );
    const probe = await screen.findByTestId(
      'probe-button',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(probe);
    const picked = await screen.findByTestId(
      'dev-feedback-picked',
      {},
      { timeout: 15_000 },
    );
    expect(picked).toHaveTextContent('新建物料');
    // 实测：React 19 的开发构建从 fiber 取不到结构化的 fileName/lineNumber，只能退回定位信息。
    expect(locateElement(probe).source).toBeUndefined();
  });

  it('截图粘贴后附上，类型与严重默认可选', async () => {
    let attachmentPosted = false;
    await renderAuthenticatedClient(<FeedbackPanel />, {
      route: '/items',
      afterResponse: async (request, response) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'GET' && pathname.endsWith('/dev/feedback')) {
          return json(snapshot);
        }
        if (
          request.method === 'POST' &&
          pathname.endsWith('/dev/feedback/attachments')
        ) {
          attachmentPosted = true;
          return json({ attachmentId: 'att-new' }, 201);
        }
        return response;
      },
    });
    const panel = await screen.findByTestId(
      'dev-feedback-panel',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(panel).getByTestId('dev-feedback-open'));
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', {
      type: 'image/png',
    });
    fireEvent.paste(panel, { clipboardData: { files: [file] } });
    await waitFor(() => expect(attachmentPosted).toBe(true), {
      timeout: 15_000,
    });
    expect(
      await screen.findByTestId(
        'dev-feedback-attachment',
        {},
        { timeout: 15_000 },
      ),
    ).toBeInTheDocument();
    expect(
      within(panel).getByTestId('dev-feedback-severe'),
    ).toBeInTheDocument();
  });
});

describe('悬浮反馈面板的快捷输入与错误提示', () => {
  // 定位方式是本机偏好，上一组用例点过「点选元素」会留下状态；每组从默认页面模式起步。
  beforeEach(() => {
    localStorage.removeItem('dev-feedback.preference');
  });

  async function openPanel(): Promise<{
    panel: HTMLElement;
    text: HTMLTextAreaElement;
    user: ReturnType<typeof userEvent.setup>;
  }> {
    await renderAuthenticatedClient(<FeedbackPanel />, {
      route: '/items',
      afterResponse: async (request, response) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'GET' && pathname.endsWith('/dev/feedback')) {
          return json(snapshot);
        }
        return response;
      },
    });
    const panel = await screen.findByTestId(
      'dev-feedback-panel',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(panel).getByTestId('dev-feedback-open'));
    const text = (await within(panel).findByTestId(
      'dev-feedback-text',
      {},
      { timeout: 15_000 },
    )) as HTMLTextAreaElement;
    return { panel, text, user: userEvent.setup() };
  }

  it('点分类在光标处插入引导句并选中，再点一次只去掉这一句', async () => {
    const { panel, text, user } = await openPanel();
    await user.type(text, '按钮显示错位');
    const display = await within(panel).findByRole(
      'button',
      {
        name: 'Wrong display',
      },
      { timeout: 15_000 },
    );
    await user.click(display);
    expect(text).toHaveValue('按钮显示错位Wrong display: ');
    expect(display).toHaveAttribute('aria-pressed', 'true');
    expect(display.querySelector('svg')).not.toBeNull();
    expect(text.selectionStart).toBe('按钮显示错位Wrong display: '.length);

    await user.type(text, '应该是蓝色');
    expect(text).toHaveValue('按钮显示错位Wrong display: 应该是蓝色');
    await user.click(display);
    expect(text).toHaveValue('按钮显示错位应该是蓝色');
    expect(display).toHaveAttribute('aria-pressed', 'false');
  });

  it('取消一个分类只去掉它插入的那句，不动另一句与用户文字', async () => {
    const { panel, text, user } = await openPanel();
    await user.type(text, '原始文字');
    await user.click(
      within(panel).getByRole('button', { name: 'Wrong display' }),
    );
    await user.click(within(panel).getByRole('button', { name: 'Wrong data' }));
    expect(text).toHaveValue('原始文字Wrong display: Wrong data: ');
    await user.type(text, '补充');
    expect(text).toHaveValue('原始文字Wrong display: Wrong data: 补充');

    await user.click(
      within(panel).getByRole('button', { name: 'Wrong display' }),
    );
    expect(text).toHaveValue('原始文字Wrong data: 补充');
    expect(
      await within(panel).findByRole(
        'button',
        { name: 'Wrong data' },
        { timeout: 15_000 },
      ),
    ).toHaveAttribute('aria-pressed', 'true');
  });

  it('正文为空时点分类不算有正文，提交仍要求至少四个字', async () => {
    const { panel, text, user } = await openPanel();
    await user.click(within(panel).getByRole('button', { name: 'Other' }));
    expect(text).toHaveValue('Other: ');
    const submit = await within(panel).findByTestId(
      'dev-feedback-submit',
      {},
      { timeout: 15_000 },
    );
    expect(submit).toBeDisabled();
    await user.type(text, '真的不行');
    await waitFor(() => expect(submit).toBeEnabled(), { timeout: 15_000 });
  });

  it('服务端 4xx 时错误提示带上能看懂的原因，不只说重试', async () => {
    let attempt = 0;
    await renderAuthenticatedClient(<FeedbackPanel />, {
      route: '/items',
      afterResponse: async (request, response) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'GET' && pathname.endsWith('/dev/feedback')) {
          return json(snapshot);
        }
        if (request.method === 'POST' && pathname.endsWith('/dev/feedback')) {
          attempt += 1;
          const reason = attempt === 1 ? 'INVALID_ARGUMENT' : 'TEXT_TOO_SHORT';
          return new Response(
            JSON.stringify({
              error: {
                status: 'INVALID_ARGUMENT',
                code: 400,
                reason,
                domain: 'devTools',
                message: 'The feedback is not valid.',
              },
            }),
            { status: 400, headers: { 'content-type': 'application/json' } },
          );
        }
        return response;
      },
    });
    const panel = await screen.findByTestId(
      'dev-feedback-panel',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(panel).getByTestId('dev-feedback-open'));
    const text = await within(panel).findByTestId(
      'dev-feedback-text',
      {},
      { timeout: 15_000 },
    );
    const user = userEvent.setup();
    await user.type(text, '按钮错位');
    const submit = await within(panel).findByTestId(
      'dev-feedback-submit',
      {},
      { timeout: 15_000 },
    );
    await waitFor(() => expect(submit).toBeEnabled(), { timeout: 15_000 });
    await user.click(submit);
    expect(
      await screen.findByRole('alert', {}, { timeout: 15_000 }),
    ).toHaveTextContent('The feedback content is invalid');
    await user.click(submit);
    await waitFor(
      () => expect(screen.getByRole('alert')).toHaveTextContent('too short'),
      { timeout: 15_000 },
    );
  });
});

describe('反馈面板收尾修复', () => {
  beforeEach(() => {
    localStorage.removeItem('dev-feedback.preference');
  });

  async function openWith(
    afterResponse: Parameters<
      typeof renderAuthenticatedClient
    >[1]['afterResponse'],
    ui: Parameters<typeof renderAuthenticatedClient>[0] = <FeedbackPanel />,
  ) {
    await renderAuthenticatedClient(ui, { route: '/items', afterResponse });
    const panel = await screen.findByTestId(
      'dev-feedback-panel',
      {},
      { timeout: 15_000 },
    );
    fireEvent.click(within(panel).getByTestId('dev-feedback-open'));
    const text = (await within(panel).findByTestId(
      'dev-feedback-text',
      {},
      { timeout: 15_000 },
    )) as HTMLTextAreaElement;
    return { panel, text, user: userEvent.setup() };
  }

  const loadSnapshot: Parameters<
    typeof renderAuthenticatedClient
  >[1]['afterResponse'] = async (request, response) =>
    new URL(request.url).pathname.endsWith('/dev/feedback') &&
    request.method === 'GET'
      ? json(snapshot)
      : response;

  it('文字属性全无的元素拾取后，拼出的请求体过服务端 zod', async () => {
    let posted: Record<string, unknown> | null = null;
    const ui = (
      <div>
        <FeedbackPanel />
        <img
          data-testid='hero-shot'
          src='data:image/gif;base64,R0lGODlhAQABAAAAACw='
        />
      </div>
    );
    const { panel, text, user } = await openWith(async (request, response) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname.endsWith('/dev/feedback'))
        return json(snapshot);
      if (request.method === 'POST' && pathname.endsWith('/dev/feedback')) {
        posted = (await request.clone().json()) as Record<string, unknown>;
        return json({ id: 'FB-900' }, 201);
      }
      return response;
    }, ui);
    await user.click(
      await within(panel).findByTestId(
        'dev-feedback-locate-element',
        {},
        { timeout: 15_000 },
      ),
    );
    await user.click(
      await screen.findByTestId('hero-shot', {}, { timeout: 15_000 }),
    );
    expect(
      await screen.findByTestId('dev-feedback-picked', {}, { timeout: 15_000 }),
    ).toHaveTextContent(/img #\d+/u);
    await user.type(text, '图片显示不出来');
    await user.click(within(panel).getByTestId('dev-feedback-submit'));
    await waitFor(() => expect(posted).not.toBeNull(), { timeout: 15_000 });
    const target = (posted as { target: Record<string, unknown> }).target;
    expect(target.text).toMatch(/^img #\d+$/u);
    expect(CreateSchema.safeParse(posted).success).toBe(true);
  });

  it('文字属性回退次序：可见文字、aria-label、alt、title、占位符、标签加序号', () => {
    const added: Element[] = [];
    const make = (attrs: Record<string, string>): HTMLElement => {
      const node = document.createElement('img');
      for (const [key, value] of Object.entries(attrs))
        node.setAttribute(key, value);
      document.body.append(node);
      added.push(node);
      return node;
    };
    try {
      const textNode = document.createElement('span');
      textNode.textContent = '保存';
      document.body.append(textNode);
      added.push(textNode);
      expect(locateElement(textNode).text).toBe('保存');
      expect(locateElement(make({ 'aria-label': '横幅' })).text).toBe('横幅');
      expect(locateElement(make({ alt: '示意图' })).text).toBe('示意图');
      expect(locateElement(make({ title: '说明' })).text).toBe('说明');
      expect(locateElement(make({ placeholder: '请填写' })).text).toBe(
        '请填写',
      );
      const nameless = make({});
      expect(locateElement(nameless).text).toMatch(/^img #\d+$/u);
      const built = buildFeedbackRequestBody({
        locate: 'element',
        route: '/items',
        element: locateElement(nameless),
        registryId: '',
        text: '图片显示不出来',
        kinds: [],
        severe: false,
      });
      expect(CreateSchema.safeParse(built).success).toBe(true);
    } finally {
      for (const node of added) node.remove();
    }
  });

  it('拾取态 Esc 回到上一模式，再按 Esc 关面板', async () => {
    const { panel, user } = await openWith(loadSnapshot);
    await user.click(
      await within(panel).findByTestId(
        'dev-feedback-locate-element',
        {},
        { timeout: 15_000 },
      ),
    );
    expect(
      await screen.findByText(
        'Click an element on the page…',
        {},
        { timeout: 15_000 },
      ),
    ).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(
      () =>
        expect(
          screen.queryByText('Click an element on the page…'),
        ).not.toBeInTheDocument(),
      { timeout: 15_000 },
    );
    expect(
      await within(panel).findByTestId(
        'dev-feedback-locate-page',
        {},
        { timeout: 15_000 },
      ),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('dev-feedback-text')).toBeInTheDocument();
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(
      () =>
        expect(
          screen.queryByTestId('dev-feedback-text'),
        ).not.toBeInTheDocument(),
      { timeout: 15_000 },
    );
  });

  it('失败提示在切模式、重开面板、新提交时都清掉', async () => {
    let attempt = 0;
    const { panel, text, user } = await openWith(async (request, response) => {
      const pathname = new URL(request.url).pathname;
      if (request.method === 'GET' && pathname.endsWith('/dev/feedback'))
        return json(snapshot);
      if (request.method === 'POST' && pathname.endsWith('/dev/feedback')) {
        attempt += 1;
        return attempt <= 2
          ? new Response(
              JSON.stringify({
                error: {
                  status: 'INVALID_ARGUMENT',
                  code: 400,
                  reason: 'INVALID_ARGUMENT',
                },
              }),
              { status: 400, headers: { 'content-type': 'application/json' } },
            )
          : json({ id: 'FB-901' }, 201);
      }
      return response;
    });
    await user.type(text, '按钮错位');
    await user.click(within(panel).getByTestId('dev-feedback-submit'));
    expect(
      await screen.findByRole('alert', {}, { timeout: 15_000 }),
    ).toBeInTheDocument();
    await user.click(
      await within(panel).findByTestId(
        'dev-feedback-locate-registry',
        {},
        { timeout: 15_000 },
      ),
    );
    await waitFor(
      () => expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
      { timeout: 15_000 },
    );

    await user.click(
      await within(panel).findByTestId(
        'dev-feedback-locate-page',
        {},
        { timeout: 15_000 },
      ),
    );
    await user.type(text, '再来一次');
    await user.click(within(panel).getByTestId('dev-feedback-submit'));
    expect(
      await screen.findByRole('alert', {}, { timeout: 15_000 }),
    ).toHaveTextContent('invalid');
    await user.click(within(panel).getByTestId('dev-feedback-toggle'));
    await user.click(within(panel).getByTestId('dev-feedback-open'));
    await waitFor(
      () => expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
      { timeout: 15_000 },
    );

    // 第三次提交成功：新提交开始时失败提示不再残留。
    await user.type(
      await within(panel).findByTestId(
        'dev-feedback-text',
        {},
        { timeout: 15_000 },
      ),
      '终于成功',
    );
    await user.click(
      await within(panel).findByTestId(
        'dev-feedback-submit',
        {},
        { timeout: 15_000 },
      ),
    );
    await waitFor(
      () => expect(screen.queryByRole('alert')).not.toBeInTheDocument(),
      { timeout: 15_000 },
    );
  });

  it('只有登记表模式限宽，登记行在面板内省略，其它模式宽度不变', async () => {
    const { panel, user } = await openWith(loadSnapshot);
    expect(panel).not.toHaveClass('max-w-md');
    await user.click(
      await within(panel).findByTestId(
        'dev-feedback-locate-registry',
        {},
        { timeout: 15_000 },
      ),
    );
    await waitFor(() => expect(panel).toHaveClass('max-w-md'), {
      timeout: 15_000,
    });
    const row = await within(panel).findByTestId(
      'dev-feedback-registry-items',
      {},
      { timeout: 15_000 },
    );
    expect(row.querySelector('span')).toHaveClass('truncate');
    await user.click(within(panel).getByTestId('dev-feedback-locate-page'));
    await waitFor(() => expect(panel).not.toHaveClass('max-w-md'), {
      timeout: 15_000,
    });
  });

  it('截图缩略图用跨密度不低于 64 的高度令牌', async () => {
    // jsdom 没有对象 URL 实现；替身只让缩略图进入 DOM，断言的是令牌类名。
    const create = URL.createObjectURL;
    const revoke = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:shot');
    URL.revokeObjectURL = vi.fn();
    try {
      let uploaded = false;
      const { panel } = await openWith(async (request, response) => {
        const pathname = new URL(request.url).pathname;
        if (request.method === 'GET' && pathname.endsWith('/dev/feedback'))
          return json(snapshot);
        if (
          request.method === 'POST' &&
          pathname.endsWith('/dev/feedback/attachments')
        ) {
          uploaded = true;
          return json({ attachmentId: 'att-new' }, 201);
        }
        return response;
      });
      const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', {
        type: 'image/png',
      });
      fireEvent.paste(panel, { clipboardData: { files: [file] } });
      await waitFor(() => expect(uploaded).toBe(true), { timeout: 15_000 });
      const thumb = await screen.findByAltText(
        'Screenshot attached',
        {},
        { timeout: 15_000 },
      );
      expect(thumb).toHaveClass('h-18');
    } finally {
      URL.createObjectURL = create;
      URL.revokeObjectURL = revoke;
    }
  });
});
