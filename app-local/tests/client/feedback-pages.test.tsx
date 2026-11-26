import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { apiClientToken, ApiClientError } from '@nocobase/app-client';
import { answerApi, renderWithApp, type ApiCall } from '@nocobase/app-testing/client';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import QualityPage from '../../client/pages/quality/index.js';
import FeedbackListPage from '../../client/pages/feedbacks/index.js';
import FeedbackNewPage from '../../client/pages/feedbacks/new.js';
import FeedbackDetailPage from '../../client/pages/feedbacks/detail.js';
import { FeedbackClient } from '../../client/pages/feedbacks/client.js';
import {
  FEEDBACK_COLUMNS,
  useFeedbackColumns,
} from '../../client/pages/feedbacks/columns.js';
import enUS from '../../client/locales/en-US.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-026 页面切片。用真实的应用 hook 与路由容器（`renderWithApp`），只把 HTTP 换成夹具：
 * `useCan` 走真实的 `GET authorization/permissions`，页面按返回的授权决定看到什么、发什么请求。
 * 这样断言的是「三人看到的页面不同」「请求真的发出去」「拒绝时用户看到哪句话」，
 * 不是被 mock 掉的组件内部状态。
 */

type Answer = unknown;

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => Answer;
const api = vi.fn((call: ApiCall) => answer(call));

function fqcGrant(...actions: string[]): AuthorizationSnapshot {
  return {
    unrestricted: false,
    permissions: [
      { resource: { type: 'composite', id: 'fqc' }, actions },
    ],
  };
}

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'f-1',
    channel: 'web',
    externalId: null,
    senderName: null,
    senderContact: null,
    content: '尺寸超差，无法装配',
    rawContentType: 'text',
    receivedAt: '2026-11-20T08:00:00.000Z',
    status: 'open',
    customerName: 'Acme',
    productName: 'Bracket',
    model: 'M1',
    batchNo: 'B-7',
    attachmentIds: [],
    ownerId: 'u-1',
    discardedAt: null,
    discardReason: null,
    createdAt: '2026-11-20T08:00:00.000Z',
    updatedAt: '2026-11-20T08:00:00.000Z',
    submitterName: 'Tester',
    attachments: [],
    canEdit: true,
    canDiscard: true,
    ...overrides,
  };
}

function errorResponse(status: number, reason: string): Response {
  return Response.json(
    { error: { message: reason, reason, domain: 'quality' } },
    { status },
  );
}

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid='location'>{location.pathname}</span>;
}

async function renderAt(
  route: string,
  overrides: { grants?: AuthorizationSnapshot } = {},
) {
  if (overrides.grants) permissions = overrides.grants;
  return renderWithApp(
    <AuthenticationProvider>
      <LocationProbe />
      <Routes>
        <Route path='/feedbacks' element={<FeedbackListPage />}>
          <Route path='new' element={<FeedbackNewPage />} />
          <Route path=':feedbackId' element={<FeedbackDetailPage />} />
        </Route>
      </Routes>
    </AuthenticationProvider>,
    {
      route,
      namespace: packageMetadata.name,
      namespaces: { [packageMetadata.name]: enUS },
      fetch: answerApi(api),
      services: (app) => {
        app.container.instance(authenticationClientToken, { getSession });
        app.container.singleton(
          authorizationClientToken,
          (resolver) =>
            new AuthorizationClient(resolver.resolve(apiClientToken)),
        );
      },
    },
  );
}

const getSession = vi.fn(async () => ({ data: null }));

async function waitForPermissions(): Promise<void> {
  await waitFor(() =>
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'GET', path: 'authorization/permissions' }),
    ),
  );
}

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  permissions = fqcGrant('submit');
  answer = (call: ApiCall) => {
    if (call.path === 'authorization/permissions') return { data: permissions };
    if (call.path === 'quality/feedbacks/mine') return { data: [], meta: { total: 0 } };
    if (call.path === 'quality/feedbacks') return { data: [], meta: { total: 0 } };
    return new Response(null, { status: 404 });
  };
});

describe('R-026 三个身份看到的页面不同', () => {
  it('普通员工只看到提交与我的，没有筛选与行上的维护按钮', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks/mine')
        return { data: [row()], meta: { total: 1, page: 1, pageSize: 20 } };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks');

    expect(
      await screen.findByRole('button', { name: enUS.feedbacks.new }),
    ).toBeInTheDocument();
    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.filters.overdue })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.form.discard })).not.toBeInTheDocument();
    expect(api.mock.calls.map(([call]) => call.path)).not.toContain('quality/feedbacks');
  });

  it('质量员看到全部与四个筛选，没有新建按钮', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks')
        return { data: [row()], meta: { total: 1, page: 1, pageSize: 20 } };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks');

    expect(await screen.findByText('Acme')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: enUS.feedbacks.filters.overdue })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: enUS.feedbacks.filters.pending })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: enUS.feedbacks.filters.status })).toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: enUS.feedbacks.filters.q })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.new })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: enUS.feedbacks.form.discard })).toBeInTheDocument();
    expect(api.mock.calls.map(([call]) => call.path)).not.toContain('quality/feedbacks/mine');
  });

  it('两个动作都没有时只看到一句说明，一个业务请求都不发', async () => {
    permissions = fqcGrant();
    await renderAt('/feedbacks');
    await waitForPermissions();

    expect(await screen.findByText(enUS.feedbacks.noAccess)).toBeVisible();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.new })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.filters.overdue })).not.toBeInTheDocument();
    expect(api.mock.calls.map(([call]) => call.path)).not.toContain('quality/feedbacks');
    expect(api.mock.calls.map(([call]) => call.path)).not.toContain('quality/feedbacks/mine');
  });

  it('只持提交反馈的人打开详情是一句说明，没有会落库的按钮', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/f-1');

    expect(await screen.findByText(enUS.feedbacks.detailNoAccess)).toBeVisible();
    await waitForPermissions();
    expect(api.mock.calls.map(([call]) => call.path)).not.toContain('quality/feedbacks/f-1');
    expect(screen.queryByRole('button', { name: enUS.feedbacks.form.save })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.form.discard })).not.toBeInTheDocument();
  });
});

describe('R-026 新建与编辑的门槛', () => {
  it('只给页面授权和 maintain 的人敲新建地址，看到说明且不渲染表单', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/new');

    expect(await screen.findByText(enUS.feedbacks.newNoAccess)).toBeVisible();
    await waitForPermissions();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.form.submit })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(
      api.mock.calls.filter(
        ([call]) => call.method === 'POST' && call.path === 'quality/feedbacks',
      ),
    ).toHaveLength(0);
  });

  it('已丢弃的行不显示编辑表单与保存按钮', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks/f-1')
        return {
          data: row({
            status: 'discarded',
            canEdit: false,
            canDiscard: false,
          }),
        };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/f-1');

    expect(
      await screen.findByText(enUS.feedbacks.detail.readOnly),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.form.save })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: enUS.feedbacks.form.discard })).not.toBeInTheDocument();
  });

  it('编辑态把清空的文本字段显式发 null，且 PATCH 不带 channel/content', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks/f-1')
        return { data: row({ note: 'old note', productName: 'Bracket', model: 'M1' }) };
      if (call.path === 'quality/feedbacks/f-1' && call.method === 'PATCH')
        return { data: row() };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/f-1');
    const dialog = await screen.findByRole('dialog', {
      name: enUS.feedbacks.form.titleEdit,
    });
    await userEvent.clear(
      await within(dialog).findByRole('textbox', { name: enUS.feedbacks.form.note }),
    );
    await userEvent.clear(
      await within(dialog).findByRole('textbox', { name: enUS.feedbacks.form.productName }),
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.feedbacks.form.save }),
    );

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'PATCH',
          path: 'quality/feedbacks/f-1',
          json: expect.objectContaining({
            note: null,
            productName: null,
          }),
        }),
      ),
    );
    const patch = api.mock.calls.find(
      ([call]) => call.method === 'PATCH' && call.path === 'quality/feedbacks/f-1',
    )![0].json as Record<string, unknown>;
    expect(patch).not.toHaveProperty('channel');
    expect(patch).not.toHaveProperty('content');
  });

  it.each([
    ['ATTACHMENT_NOT_FOUND', 404, 'attachmentNotFound'],
    ['OPERATION_CONFLICT', 409, 'operationConflict'],
    ['INVALID_MULTIPART', 400, 'invalidMultipart'],
    ['UNSUPPORTED_MEDIA_TYPE', 415, 'unsupportedMediaType'],
  ])('%s 也有专属的一句话', async (reason, status, key) => {
    const spy = vi.spyOn(FeedbackClient.prototype, 'upload').mockRejectedValue(
      new ApiClientError(reason, {
        status,
        reason,
        method: 'POST',
        url: '/api/quality/feedback-files',
      }),
    );
    try {
      await renderAt('/feedbacks/new');
      const dialog = await screen.findByRole('dialog', {
        name: enUS.feedbacks.form.titleNew,
      });
      await userEvent.upload(
        within(dialog).getByLabelText(enUS.feedbacks.form.attachments),
        new File(['abc'], 'photo.png', { type: 'image/png' }),
      );
      expect(
        await within(dialog).findByText(
          enUS.feedbacks.errors[key as keyof typeof enUS.feedbacks.errors] as string,
        ),
      ).toBeVisible();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('R-026 提交', () => {
  it('替客户记录：客户不填提交不了，填了能提交并回到列表', async () => {
    let created = false;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks' && call.method === 'POST') {
        created = true;
        return { data: row({ id: 'f-new', customerName: 'New Co' }) };
      }
      if (call.path === 'quality/feedbacks/mine')
        return { data: created ? [row({ id: 'f-new', customerName: 'New Co' })] : [], meta: { total: 0 } };
      return new Response(null, { status: 404 });
    };
    const view = await renderAt('/feedbacks/new');

    const dialog = await screen.findByRole('dialog', { name: enUS.feedbacks.form.titleNew });
    await userEvent.click(within(dialog).getByRole('radio', { name: enUS.feedbacks.form.sourceProxy }));
    expect(await within(dialog).findByText(enUS.feedbacks.form.customerName)).toBeVisible();
    expect(within(dialog).queryByText(enUS.feedbacks.form.senderName)).toBeInTheDocument();
    // 描述先填好，单独把客户留空：这条只守「替客户记录必须填客户」，不被描述的必填挡住。
    await userEvent.type(within(dialog).getByRole('textbox', { name: enUS.feedbacks.form.content }), '尺寸超差');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.feedbacks.form.submit }));
    expect(created, '客户没填时不能发出提交').toBe(false);
    expect(await screen.findByText(enUS.feedbacks.errors.customerRequired)).toBeVisible();

    await userEvent.type(within(dialog).getByRole('textbox', { name: enUS.feedbacks.form.customerName }), 'New Co');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.feedbacks.form.submit }));

    await waitFor(() => expect(view.toasts()).toEqual([
      expect.objectContaining({ type: 'success', title: enUS.feedbacks.form.created }),
    ]));
    await waitFor(
      () => expect(screen.getByTestId('location')).toHaveTextContent(/^\/feedbacks$/),
      { timeout: 15_000 },
    );
    expect(await screen.findByText('New Co')).toBeInTheDocument();
  });

  it('本人提交时客户、联系人、联系方式不出现', async () => {
    await renderAt('/feedbacks/new');
    const dialog = await screen.findByRole('dialog', { name: enUS.feedbacks.form.titleNew });
    expect(within(dialog).queryByText(enUS.feedbacks.form.customerName)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(enUS.feedbacks.form.senderName)).not.toBeInTheDocument();
    expect(within(dialog).queryByText(enUS.feedbacks.form.senderContact)).not.toBeInTheDocument();
  });

  it('400 CUSTOMER_REQUIRED 映射成看得懂的一句话', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks' && call.method === 'POST')
        return errorResponse(400, 'CUSTOMER_REQUIRED');
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/new');
    const dialog = await screen.findByRole('dialog', { name: enUS.feedbacks.form.titleNew });
    await userEvent.click(within(dialog).getByRole('radio', { name: enUS.feedbacks.form.sourceProxy }));
    await userEvent.type(within(dialog).getByRole('textbox', { name: enUS.feedbacks.form.customerName }), 'Acme');
    await userEvent.type(within(dialog).getByRole('textbox', { name: enUS.feedbacks.form.content }), '尺寸超差');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.feedbacks.form.submit }));

    expect(await screen.findByText(enUS.feedbacks.errors.customerRequired)).toBeVisible();
  });

  it('认不出的原因码给通用提示并保留原因码', async () => {
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks' && call.method === 'POST')
        return errorResponse(409, 'SOMETHING_NEW');
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/new');
    const dialog = await screen.findByRole('dialog', { name: enUS.feedbacks.form.titleNew });
    await userEvent.type(within(dialog).getByRole('textbox', { name: enUS.feedbacks.form.content }), '尺寸超差');
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.feedbacks.form.submit }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(enUS.feedbacks.errors.generic.replace('{{reason}}', 'SOMETHING_NEW'));
    expect(alert).toHaveTextContent('SOMETHING_NEW');
  });
});

describe('R-026 附件上传（S4 契约）', () => {
  const png = () => new File(['abc'], 'photo.png', { type: 'image/png' });
  const uploaded = {
    id: 'file-1',
    filename: 'photo.png',
    mimeType: 'image/png',
    size: 3,
  };

  it('客户端按 multipart 的 file 字段调用上传端点', async () => {
    const request = vi.fn(async () => ({ data: uploaded }));
    const client = new FeedbackClient({ request } as never);
    const file = png();
    expect(await client.upload(file)).toEqual(uploaded);

    const options = request.mock.calls[0]![0] as {
      method: string;
      path: string;
      body: FormData;
    };
    expect(options.path).toBe('quality/feedback-files');
    expect(options.method).toBe('POST');
    expect(options.body, 'body 是 multipart').toBeInstanceOf(FormData);
    expect(options.body.get('file'), '文件字段名是 file').toBe(file);
  });

  it('上传成功后把标识放进新建请求的 attachmentIds', async () => {
    const spy = vi
      .spyOn(FeedbackClient.prototype, 'upload')
      .mockResolvedValue(uploaded);
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks' && call.method === 'POST')
        return { data: row({ id: 'f-new' }) };
      if (call.path === 'quality/feedbacks/mine') return { data: [], meta: { total: 0 } };
      return new Response(null, { status: 404 });
    };
    try {
      const view = await renderAt('/feedbacks/new');
      const dialog = await screen.findByRole('dialog', {
        name: enUS.feedbacks.form.titleNew,
      });

      await userEvent.upload(
        within(dialog).getByLabelText(enUS.feedbacks.form.attachments),
        png(),
      );
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      expect(await within(dialog).findByText('photo.png')).toBeVisible();

      await userEvent.type(
        within(dialog).getByRole('textbox', { name: enUS.feedbacks.form.content }),
        '尺寸超差',
      );
      await userEvent.click(
        within(dialog).getByRole('button', { name: enUS.feedbacks.form.submit }),
      );
      await waitFor(() =>
        expect(api).toHaveBeenCalledWith(
          expect.objectContaining({
            method: 'POST',
            path: 'quality/feedbacks',
            json: expect.objectContaining({ attachmentIds: ['file-1'] }),
          }),
        ),
      );
      expect(view.toasts()).toEqual([
        expect.objectContaining({
          type: 'success',
          title: enUS.feedbacks.form.created,
        }),
      ]);
    } finally {
      spy.mockRestore();
    }
  });

  it.each([
    [413, 'FILE_TOO_LARGE', 'fileTooLarge'],
    [415, 'FILE_TYPE_NOT_ALLOWED', 'fileType'],
  ])('上传被服务端以 %s %s 拒绝时给出看得懂的提示', async (status, reason, key) => {
    const spy = vi.spyOn(FeedbackClient.prototype, 'upload').mockRejectedValue(
      new ApiClientError(reason, {
        status,
        reason,
        method: 'POST',
        url: '/api/quality/feedback-files',
      }),
    );
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks' && call.method === 'POST')
        return { data: row({ id: 'f-new' }) };
      if (call.path === 'quality/feedbacks/mine') return { data: [], meta: { total: 0 } };
      return new Response(null, { status: 404 });
    };
    try {
      await renderAt('/feedbacks/new');
      const dialog = await screen.findByRole('dialog', {
        name: enUS.feedbacks.form.titleNew,
      });

      await userEvent.upload(
        within(dialog).getByLabelText(enUS.feedbacks.form.attachments),
        png(),
      );
      expect(
        await within(dialog).findByText(
          enUS.feedbacks.errors[key as keyof typeof enUS.feedbacks.errors] as string,
        ),
      ).toBeVisible();
      expect(within(dialog).queryByText('photo.png')).not.toBeInTheDocument();

      // 上传失败的文件绝不能被带进提交请求。
      await userEvent.type(
        within(dialog).getByRole('textbox', { name: enUS.feedbacks.form.content }),
        '尺寸超差',
      );
      await userEvent.click(
        within(dialog).getByRole('button', { name: enUS.feedbacks.form.submit }),
      );
      await waitFor(() =>
        expect(api).toHaveBeenCalledWith(
          expect.objectContaining({
            path: 'quality/feedbacks',
            json: expect.objectContaining({ attachmentIds: [] }),
          }),
        ),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('R-026 附件数量上限', () => {
  it('一次选 12 个只上传 10 个，不制造孤儿文件', async () => {
    let uploaded = 0;
    const spy = vi
      .spyOn(FeedbackClient.prototype, 'upload')
      .mockImplementation(async () => ({
        id: `file-${uploaded++}`,
        filename: 'photo.png',
        mimeType: 'image/png',
        size: 3,
      }));
    try {
      await renderAt('/feedbacks/new');
      const dialog = await screen.findByRole('dialog', {
        name: enUS.feedbacks.form.titleNew,
      });
      const files = Array.from(
        { length: 12 },
        (_, index) =>
          new File(['abc'], `photo-${index}.png`, { type: 'image/png' }),
      );
      await userEvent.upload(
        within(dialog).getByLabelText(enUS.feedbacks.form.attachments),
        files,
      );
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(10));
      expect(spy.mock.calls.map(([file]) => (file as File).name)).toEqual(
        files.slice(0, 10).map((file) => file.name),
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('R-026 筛选', () => {
  it('「超过七天未处理」发出 overdue=true，隐含待处理', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks')
        return { data: [row()], meta: { total: 1 } };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks');
    await screen.findByText('Acme');

    await userEvent.click(screen.getByRole('button', { name: enUS.feedbacks.filters.overdue }));

    await waitFor(() =>
      expect(api).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'GET',
          path: 'quality/feedbacks',
          query: expect.objectContaining({ overdue: 'true', pending: 'true' }),
        }),
      ),
    );
  });
});

describe('R-026 丢弃', () => {
  it('要先确认，取消不发出请求', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks')
        return { data: [row()], meta: { total: 1 } };
      if (call.path === 'quality/feedbacks/f-1')
        return { data: row() };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/f-1');
    await userEvent.click(await screen.findByRole('button', { name: enUS.feedbacks.form.discard }));

    const dialog = await screen.findByRole('alertdialog', { name: enUS.feedbacks.form.discardTitle });
    expect(within(dialog).getByRole('button', { name: enUS.feedbacks.form.discardConfirm })).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.actions.cancel }));
    expect(api.mock.calls.some(([call]) => String(call.path).includes('/discard'))).toBe(false);
  });

  it('已有工单的 409 FEEDBACK_DISPATCHED 挡住并说明原因', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks/f-1') return { data: row() };
      if (String(call.path).includes('/discard'))
        return errorResponse(409, 'FEEDBACK_DISPATCHED');
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/f-1');
    await userEvent.click(await screen.findByRole('button', { name: enUS.feedbacks.form.discard }));
    const dialog = await screen.findByRole('alertdialog', { name: enUS.feedbacks.form.discardTitle });
    await userEvent.click(within(dialog).getByRole('button', { name: enUS.feedbacks.form.discardConfirm }));

    expect(await screen.findByText(enUS.feedbacks.errors.dispatched)).toBeVisible();
  });
});

describe('R-026 质量页的新建反馈入口', () => {
  async function renderQualityAt(grants: AuthorizationSnapshot) {
    permissions = grants;
    return renderWithApp(
      <AuthenticationProvider>
        <QualityPage />
      </AuthenticationProvider>,
      {
        route: '/quality',
        namespace: packageMetadata.name,
        namespaces: { [packageMetadata.name]: enUS },
        fetch: answerApi(api),
        services: (app) => {
          app.container.instance(authenticationClientToken, { getSession });
          app.container.singleton(
            authorizationClientToken,
            (resolver) =>
              new AuthorizationClient(resolver.resolve(apiClientToken)),
          );
        },
      },
    );
  }

  it('两个业务动作都没有时不显示入口，槽位也不报错', async () => {
    await renderQualityAt(fqcGrant());
    await waitForPermissions();

    const entry = await screen.findByTestId('feedback-entry');
    expect(entry).toHaveClass('min-h-11');
    expect(
      within(entry).queryByRole('button', { name: enUS.quality.newFeedback }),
    ).not.toBeInTheDocument();
    expect(
      api.mock.calls.map(([call]) => call.path),
    ).not.toContain('quality/intake');
  });

  it('权限悬置期槽位保持同一高度，落定后按钮在原节点里出现', async () => {
    const gate = Promise.withResolvers<unknown>();
    const priorAnswer = answer;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return gate.promise;
      return priorAnswer(call);
    };
    try {
      await renderQualityAt(fqcGrant('view', 'submit'));

      const entry = await screen.findByTestId('feedback-entry');
      expect(entry).toHaveClass('min-h-11');
      expect(
        within(entry).queryByRole('button', { name: enUS.quality.newFeedback }),
      ).not.toBeInTheDocument();

      await act(async () => gate.resolve({ data: permissions }));

      const link = await within(entry).findByRole('button', {
        name: enUS.quality.newFeedback,
      });
      expect(screen.getByTestId('feedback-entry')).toBe(entry);
      expect(link.getAttribute('href')).toMatch(/\/feedbacks\/new$/);
    } finally {
      answer = priorAnswer;
    }
  });
});

describe('R-026 稳定性', () => {
  it('骨架行渲染真实行标签，数据行的行类与骨架行一致（等高）', async () => {
    permissions = fqcGrant('maintain');
    const gate = Promise.withResolvers<unknown>();
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks') return gate.promise;
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks');

    const list = await screen.findByTestId('feedback-list');
    const skeletonRows = list.querySelectorAll('[data-testid="feedback-skeleton-row"]');
    expect(skeletonRows, '列表请求还没回来，骨架行应该铺着').toHaveLength(8);
    const skeletonTexts = [...skeletonRows].map((node) => node.textContent ?? '');
    for (const text of skeletonTexts)
      expect(text.length, '每个骨架行都要有真实文本，不是空盒子').toBeGreaterThan(0);
    expect(skeletonTexts[0]).toContain(enUS.feedbacks.loadingRowLabel);
    expect(skeletonRows[0]!.querySelector('[data-slot="skeleton"]'), '骨架块不许撑高行盒').toHaveClass('h-3');
    const rowClass = skeletonRows[0]!.className;

    await act(async () => gate.resolve({ data: [row()], meta: { total: 1 } }));

    const firstCell = await within(list).findByText('Acme');
    const dataRow = firstCell.closest('[data-testid="feedback-row-cells"]') as HTMLElement;
    expect(dataRow.className, '数据行的行类要和骨架行一字不差，高度差才是 0').toBe(rowClass);
    expect(list.querySelectorAll('[data-testid="feedback-skeleton-row"]')).toHaveLength(0);
  });

  it('骨架行与数据行共用带 min-h 的行类和同一组列：数据到达时行高不变', async () => {
    permissions = fqcGrant('maintain');
    const gate = Promise.withResolvers<unknown>();
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks') return gate.promise;
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks');

    const list = await screen.findByTestId('feedback-list');
    const skeletonRows = list.querySelectorAll('[data-testid="feedback-skeleton-row"]');
    expect(skeletonRows, '请求被门控时骨架先铺着').toHaveLength(8);
    const skeletonRow = skeletonRows[0] as HTMLElement;
    // 行高由共享行类里的 min-h 钉住，不受单元格内容（按钮 vs h-3 骨架）影响。
    expect(skeletonRow, '共享行类要锁定到能容纳操作按钮的最小高度，骨架与数据才等高').toHaveClass('min-h-14');
    const skeletonCells = skeletonRow.children.length;
    expect(skeletonCells, '骨架行单元格数 = 列数 + 操作列').toBe(FEEDBACK_COLUMNS.length + 1);
    const rowClass = skeletonRow.className;

    await act(async () => gate.resolve({ data: [row()], meta: { total: 1 } }));

    const dataRow = (await within(list).findByText('Acme')).closest(
      '[data-testid="feedback-row-cells"]',
    ) as HTMLElement | null;
    expect(dataRow, '数据行要出现').not.toBeNull();
    expect(dataRow!.className, '数据行与骨架行用同一个行类，行高差为 0').toBe(rowClass);
    expect(dataRow!.children.length, '数据行与骨架行用同一组列').toBe(skeletonCells);
    expect(list.querySelectorAll('[data-testid="feedback-skeleton-row"]')).toHaveLength(0);
  });

  it('列定义是模块级的稳定引用，不随渲染新建', () => {
    const seen: unknown[] = [];
    const view = renderHook(() => {
      seen.push(useFeedbackColumns());
      return null;
    });
    view.rerender();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0]);
  });

  it('新建表单附件区与提示区定高：0/1/3 个附件和出错提示都不挤动字段', async () => {
    let nextId = 0;
    const spy = vi
      .spyOn(FeedbackClient.prototype, 'upload')
      .mockImplementation(async (file) => ({
        id: `file-${nextId++}`,
        filename: file.name,
        mimeType: file.type || 'image/png',
        size: file.size,
      }));
    try {
      await renderAt('/feedbacks/new');
      const dialog = await screen.findByRole('dialog', {
        name: enUS.feedbacks.form.titleNew,
      });
      const fields = within(dialog).getByTestId('feedback-form-fields');
      const product = within(fields).getByRole('textbox', {
        name: enUS.feedbacks.form.productName,
      });
      const attachmentList = within(dialog).getByTestId('feedback-attachment-list');
      const messages = within(dialog).getByTestId('feedback-form-messages');
      // 空态也占一样高：附件增加只在自己的定高窗口里滚动，提示出现不撑开容器。
      expect(attachmentList, '附件区定高，空态也占位').toHaveClass('h-20');
      expect(attachmentList, '附件多了内部滚动，不把按钮顶走').toHaveClass('overflow-y-auto');
      expect(messages, '提示区定高，空态也占位').toHaveClass('h-16');
      expect(messages, '提示过多时内部滚动，不顶走按钮').toHaveClass('overflow-y-auto');
      expect(attachmentList.children).toHaveLength(0);

      const fileInput = within(dialog).getByLabelText(enUS.feedbacks.form.attachments);
      await userEvent.upload(fileInput, new File(['a'], 'one.png', { type: 'image/png' }));
      await waitFor(() => expect(attachmentList.children).toHaveLength(1));
      expect(within(dialog).getByTestId('feedback-form-fields')).toBe(fields);
      expect(within(fields).getByRole('textbox', { name: enUS.feedbacks.form.productName })).toBe(product);

      await userEvent.upload(fileInput, [
        new File(['b'], 'two.png', { type: 'image/png' }),
        new File(['c'], 'three.png', { type: 'image/png' }),
      ]);
      await waitFor(() => expect(attachmentList.children).toHaveLength(3));
      expect(within(dialog).getByTestId('feedback-form-fields')).toBe(fields);
      expect(attachmentList).toHaveClass('h-20');

      // 空描述提交触发校验提示：字段节点不变，提示区仍定高。
      await userEvent.click(
        within(dialog).getByRole('button', { name: enUS.feedbacks.form.submit }),
      );
      expect(
        await within(messages).findByText(enUS.feedbacks.form.contentRequired),
      ).toBeVisible();
      expect(messages).toHaveClass('h-16');
      expect(within(dialog).getByTestId('feedback-form-fields')).toBe(fields);
      expect(within(fields).getByRole('textbox', { name: enUS.feedbacks.form.productName })).toBe(product);
    } finally {
      spy.mockRestore();
    }
  });

  it('编辑态带三个附件时操作行 sticky 在滚动体内，提交按钮初始可见', async () => {
    permissions = fqcGrant('maintain');
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks/f-1')
        return {
          data: row({
            attachments: [1, 2, 3].map((n) => ({
              id: `a-${n}`,
              filename: `file-${n}.png`,
              mimeType: 'image/png',
              size: 70,
              url: `/api/files/${n}`,
            })),
          }),
        };
      return new Response(null, { status: 404 });
    };
    await renderAt('/feedbacks/f-1');

    const dialog = await screen.findByRole('dialog', {
      name: enUS.feedbacks.form.titleEdit,
    });
    // 等详情数据装配完，再量列表里的三个附件，不是空态。
    const attachmentList = await within(dialog).findByTestId('feedback-attachment-list');
    expect(attachmentList.children).toHaveLength(3);
    const body = dialog.querySelector('[data-slot="route-overlay-body"]');
    expect(body, '内容在可滚动体里').toHaveClass('overflow-y-auto');
    const actions = within(dialog).getByTestId('feedback-form-actions');
    // sticky 把操作行钉在滚动体底部：再多附件也不会把提交按钮挤出可视区。
    expect(actions, '操作行 sticky 在滚动体底部').toHaveClass('sticky');
    expect(actions).toHaveClass('bottom-0');
    expect(actions, '按钮有底色，滚动内容不会透出来').toHaveClass('bg-popover');
    expect(
      within(actions).getByRole('button', { name: enUS.feedbacks.form.save }),
    ).toBeVisible();
  });

  it('新建态加载占位与落定表单共用同一高度类：首帧和落定对话框一样高', async () => {
    const gate = Promise.withResolvers<unknown>();
    const priorAnswer = answer;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return gate.promise;
      return priorAnswer(call);
    };
    try {
      await renderAt('/feedbacks/new');
      const dialog = await screen.findByRole('dialog', {
        name: enUS.feedbacks.form.titleNew,
      });
      const shell = await within(dialog).findByTestId('feedback-form-shell');
      expect(shell, '权限判定中的占位与落定同高').toHaveClass('min-h-dvh');
      const loadingClass = shell.className;

      await act(async () => gate.resolve({ data: permissions }));

      const settled = await within(dialog).findByTestId('feedback-form-shell');
      expect(settled, '还是同一个外壳节点').toBe(shell);
      expect(settled.className, '高度类前后一致，对话框顶边不动').toBe(loadingClass);
      expect(
        await within(settled).findByRole('button', { name: enUS.feedbacks.form.submit }),
      ).toBeInTheDocument();
    } finally {
      answer = priorAnswer;
    }
  });

  it('编辑态加载占位与落定表单共用同一高度类：首帧和落定对话框一样高', async () => {
    permissions = fqcGrant('maintain');
    const gate = Promise.withResolvers<unknown>();
    const priorAnswer = answer;
    answer = (call) => {
      if (call.path === 'authorization/permissions') return { data: permissions };
      if (call.path === 'quality/feedbacks/f-1') return gate.promise;
      return priorAnswer(call);
    };
    try {
      await renderAt('/feedbacks/f-1');
      const dialog = await screen.findByRole('dialog', {
        name: enUS.feedbacks.form.titleEdit,
      });
      const shell = await within(dialog).findByTestId('feedback-form-shell');
      expect(shell, '详情读取中的占位与落定同高').toHaveClass('min-h-dvh');
      const loadingClass = shell.className;

      await act(async () => gate.resolve({ data: row() }));

      const settled = await within(dialog).findByTestId('feedback-form-shell');
      expect(settled, '还是同一个外壳节点').toBe(shell);
      expect(settled.className, '高度类前后一致，对话框顶边不动').toBe(loadingClass);
      expect(
        await within(settled).findByRole('button', { name: enUS.feedbacks.form.save }),
      ).toBeInTheDocument();
    } finally {
      answer = priorAnswer;
    }
  });
});
