import {
  AuthenticationProvider,
  authenticationClientToken,
} from '@nocobase/app-plugin-authentication/client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationSnapshot,
} from '@nocobase/app-plugin-authorization/client';
import { apiClientToken } from '@nocobase/app-client';
import {
  answerApi,
  renderWithApp,
  type ApiCall,
} from '@nocobase/app-testing/client';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { type ReactElement } from 'react';
import { Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import enUS from '../../client/locales/en-US.js';
import ShiftCopyPage from '../../client/pages/shifts/copy.js';
import ShiftEditPage from '../../client/pages/shifts/edit.js';
import ShiftsPage from '../../client/pages/shifts/index.js';
import ShiftNewPage from '../../client/pages/shifts/new.js';

import packageMetadata from '../../package.json' with { type: 'json' };

/**
 * R-025 班次定义页。真实的应用 hook 与路由容器（`renderWithApp`），只把 HTTP 换成夹具：
 * `useCan` 走真实的权限快照，页面按它决定画什么、发什么请求。示例数据一律编造。
 */
const T = 15_000;
const WAIT = { timeout: T };
const manager: AuthorizationSnapshot = { unrestricted: true, permissions: [] };
const viewer: AuthorizationSnapshot = {
  unrestricted: false,
  permissions: [
    { resource: { type: 'composite', id: 'shifts' }, actions: ['view'] },
  ],
};
const notFound = () => new Response(null, { status: 404 });

function shift(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: 'EARLY',
    title: 'Sample early shift',
    startMinute: 480,
    endMinute: 1020,
    breakStartMinute: 720,
    breakEndMinute: 780,
    active: true,
    sortOrder: 10,
    createdAt: '2026-11-01T00:00:00.000Z',
    updatedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}
const night = shift({
  id: 'NIGHT',
  title: 'Sample night shift',
  startMinute: 1320,
  endMinute: 360,
  breakStartMinute: null,
  breakEndMinute: null,
});

let permissions: AuthorizationSnapshot;
let answer: (call: ApiCall) => unknown;
const api = vi.fn((call: ApiCall) =>
  call.path === 'authorization/permissions'
    ? { data: permissions }
    : answer(call),
);
const getSession = vi.fn(async () => ({ data: null }));

function LocationProbe(): ReactElement {
  const location = useLocation();
  return <span data-testid='location'>{location.pathname}</span>;
}

async function renderAt(route: string, grants: AuthorizationSnapshot) {
  permissions = grants;
  return renderWithApp(
    <AuthenticationProvider>
      <LocationProbe />
      <Routes>
        <Route path='/shifts' element={<ShiftsPage />}>
          <Route path='new' element={<ShiftNewPage />} />
          <Route path=':shiftId/edit' element={<ShiftEditPage />} />
          <Route path=':shiftId/copy' element={<ShiftCopyPage />} />
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

/** 等表单的某个输入框出现，返回它所在的那个对话框。 */
async function liveDialog(textboxName: string): Promise<HTMLElement> {
  const field = await screen.findByRole('textbox', { name: textboxName }, WAIT);
  return field.closest<HTMLElement>('[role="dialog"]')!;
}

const posts = () =>
  api.mock.calls.map(([call]) => call).filter((call) => call.method === 'POST');
const patches = () =>
  api.mock.calls
    .map(([call]) => call)
    .filter((call) => call.method === 'PATCH');
const ruleError = (status: number, reason: string, message: string): Response =>
  Response.json(
    {
      error: {
        message: 'raw',
        reason,
        localizedMessage: { locale: 'en-US', message },
      },
    },
    { status },
  );

beforeEach(() => {
  api.mockClear();
  getSession.mockClear();
  answer = notFound;
});

describe('R-025 班次定义页', () => {
  it('lists shifts with the request the endpoint expects and marks overnight ones', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'shifts'
        ? { items: [shift(), night], total: 2, page: 1, pageSize: 20 }
        : notFound();
    await renderAt('/shifts', manager);

    expect(
      await screen.findByText('Sample early shift', {}, WAIT),
    ).toBeVisible();
    expect(screen.getByText('08:00 – 17:00')).toBeVisible();
    expect(screen.getByText('12:00 – 13:00')).toBeVisible();
    expect(screen.getByText('22:00 – 06:00')).toBeVisible();
    // 只有夜班是跨天的：除表头外徽标恰好一个。
    const overnight = screen.getAllByText(enUS.shifts.crossMidnight);
    expect(overnight.filter((node) => node.tagName !== 'TH')).toHaveLength(1);
    expect(screen.getAllByText('2 found').length).toBeGreaterThan(0);
    expect(api).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'GET',
        path: 'shifts',
        query: { page: '1', pageSize: '20' },
      }),
    );
    expect(
      await screen.findByRole('button', { name: enUS.shifts.new }, WAIT),
    ).toHaveAttribute('href', '/shifts/new');
  });

  it('creates a shift: times become minutes from midnight, then the dialog closes', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'shifts'
        ? shift({ id: 'LATE-2', title: 'Sample late shift' })
        : notFound();
    const view = await renderAt('/shifts/new', manager);
    const code = await screen.findByRole('textbox', { name: 'Code' }, WAIT);

    await userEvent.type(code, 'late-2');
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Name' }),
      'Sample late shift',
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Start' }),
      '14:00',
    );
    await userEvent.type(screen.getByRole('textbox', { name: 'End' }), '22:00');
    await userEvent.click(
      screen.getByRole('button', { name: enUS.erp.actions.create }),
    );

    await waitFor(
      () =>
        expect(posts()[0]?.json).toEqual({
          id: 'LATE-2',
          title: 'Sample late shift',
          startMinute: 840,
          endMinute: 1320,
          sortOrder: 0,
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Created shift "Sample late shift"',
      }),
    ]);
    await waitFor(
      () =>
        expect(screen.getByTestId('location')).toHaveTextContent(/^\/shifts$/),
      WAIT,
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull(), WAIT);
  });

  it('shows the server sentence when the endpoint answers 422 and keeps the dialog open', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'shifts'
        ? ruleError(422, 'SHIFT_REJECTED', 'The server refused this shift.')
        : notFound();
    const view = await renderAt('/shifts/new', manager);
    // 权限落定前对话框里是一句「加载中」，表单是之后换进来的：从活着的输入框往上找对话框。
    const dialog = await liveDialog('Name');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Code' }),
      'DUP-1',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Start' }),
      '08:00',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'End' }),
      '17:00',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    // 被拒时先显示服务端翻好的那句话；对话框不关，输入还在。
    expect(
      await screen.findByText('The server refused this shift.', {}, WAIT),
    ).toBeVisible();
    expect(within(dialog).getByRole('textbox', { name: 'Code' })).toHaveValue(
      'DUP-1',
    );
    expect(posts()).toHaveLength(1);
    expect(view.toasts()).toEqual([]);
  });

  it('a taken code puts the server sentence under the code field', async () => {
    answer = (call) =>
      call.method === 'POST' && call.path === 'shifts'
        ? ruleError(
            409,
            'SHIFT_CODE_EXISTS',
            'That shift code is already in use.',
          )
        : notFound();
    await renderAt('/shifts/new', manager);
    const dialog = await liveDialog('Name');
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Code' }),
      'EARLY',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Name' }),
      'Sample',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Start' }),
      '08:00',
    );
    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'End' }),
      '17:00',
    );
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    // 一句在上面的提示条里，一句标在编码那一项下面。
    expect(
      await screen.findAllByText(
        'That shift code is already in use.',
        {},
        WAIT,
      ),
    ).toHaveLength(2);
  });

  it('validates on submit only: a missing name is marked under the name and nothing is sent', async () => {
    await renderAt('/shifts/new', manager);
    const dialog = await liveDialog('Name');
    // 等到提交按钮出现，表单才算画完，再断言「还没有提示」。
    await screen.findByRole('button', { name: enUS.erp.actions.create }, WAIT);
    expect(within(dialog).queryByText(enUS.erp.form.required)).toBeNull();
    await userEvent.click(
      within(dialog).getByRole('button', { name: enUS.erp.actions.create }),
    );

    // 编码、名称、两个时间四项必填：四句提示，名称那一项在其中。
    expect(
      await screen.findAllByText(enUS.erp.form.required, {}, WAIT),
    ).toHaveLength(4);
    expect(posts()).toHaveLength(0);
  });

  it('editing reads the latest shift and sends only the title and the sort order', async () => {
    answer = (call) => {
      if (call.method === 'GET' && call.path === 'shifts/EARLY') return shift();
      if (call.method === 'PATCH' && call.path === 'shifts/EARLY')
        return shift({ title: 'Sample early shift A' });
      return notFound();
    };
    const view = await renderAt('/shifts/EARLY/edit', manager);
    const name = await screen.findByRole('textbox', { name: 'Name' }, WAIT);
    expect(name).toHaveValue('Sample early shift');
    // 起止时间与编码是只读的：页面上只有名称、排序两个输入框。
    expect(screen.getAllByRole('textbox')).toHaveLength(2);
    await userEvent.type(name, ' A');
    await userEvent.click(
      screen.getByRole('button', { name: enUS.erp.actions.save }),
    );

    await waitFor(
      () =>
        expect(patches()[0]?.json).toEqual({
          title: 'Sample early shift A',
          sortOrder: 10,
        }),
      WAIT,
    );
    expect(view.toasts()).toEqual([
      expect.objectContaining({
        type: 'success',
        title: 'Saved shift "Sample early shift A"',
      }),
    ]);
  });

  it('deactivating asks first; only the confirmation posts deactivate and the row leaves', async () => {
    let deactivated = false;
    answer = (call) => {
      if (call.method === 'POST' && call.path === 'shifts/EARLY/deactivate') {
        deactivated = true;
        return shift({ active: false });
      }
      if (call.method === 'GET' && call.path === 'shifts')
        return deactivated
          ? { items: [night], total: 1, page: 1, pageSize: 20 }
          : { items: [shift(), night], total: 2, page: 1, pageSize: 20 };
      return notFound();
    };
    await renderAt('/shifts', manager);
    await screen.findByText('Sample early shift', {}, WAIT);
    await userEvent.click(
      await screen.findByRole(
        'button',
        { name: 'Actions for Sample early shift' },
        WAIT,
      ),
    );
    await userEvent.click(
      await screen.findByRole(
        'menuitem',
        { name: enUS.erp.actions.deactivate },
        WAIT,
      ),
    );
    const confirm = await screen.findByRole(
      'alertdialog',
      { name: 'Deactivate shift "Sample early shift"?' },
      WAIT,
    );
    // 点了「停用」不等于停用了：确认之前一个写请求都没有。
    expect(posts()).toHaveLength(0);

    await userEvent.click(
      within(confirm).getByRole('button', {
        name: enUS.erp.actions.deactivate,
      }),
    );
    await waitFor(
      () =>
        expect(
          screen.queryByText('Sample early shift'),
        ).not.toBeInTheDocument(),
      WAIT,
    );
    expect(posts().map((call) => call.path)).toEqual([
      'shifts/EARLY/deactivate',
    ]);
  });

  it('a viewer without manage sees no create button and no row menu', async () => {
    answer = (call) =>
      call.method === 'GET' && call.path === 'shifts'
        ? { items: [shift()], total: 1, page: 1, pageSize: 20 }
        : notFound();
    await renderAt('/shifts', viewer);
    expect(
      await screen.findByText('Sample early shift', {}, WAIT),
    ).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), WAIT);

    expect(
      screen.queryByRole('button', { name: enUS.shifts.new }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Actions for Sample early shift' }),
    ).not.toBeInTheDocument();
  });

  it('a viewer without manage opening the new address gets a note, no form, no request', async () => {
    await renderAt('/shifts/new', viewer);

    expect(
      await screen.findByText(enUS.erp.form.noWrite, {}, WAIT),
    ).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(posts()).toHaveLength(0);
  });
});
