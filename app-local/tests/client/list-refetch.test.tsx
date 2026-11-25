import { renderSettingsClient as renderWithApp } from '../helpers/settings-client.js';
import { answerApi } from '@nocobase/app-testing/client';
import { apiClientToken, type ClientApplication } from '@nocobase/app-client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationOptionsResponse,
} from '@nocobase/app-plugin-authorization/client';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes, useOutletContext } from 'react-router';
import { expect, it, vi } from 'vitest';
import UsersPage from '../../client/pages/settings/users.js';
import RolesPage from '../../client/pages/settings/roles.js';
import DefaultAccessPage from '../../client/pages/settings/default-access.js';
import enUS from '../../client/locales/en-US.js';

const namespace = '@nocobase/list-refetch-test';
const namespaces = {
  [namespace]: {
    'en-US': async () => ({ default: enUS }),
  },
};
const services = (app: ClientApplication) =>
  app.container.instance(
    authorizationClientToken,
    new AuthorizationClient(app.container.resolve(apiClientToken)),
  );
const options = { data: { roleScopes: [] } };
const alice = {
  id: 'alice',
  name: 'Alice',
  username: 'alice',
  email: 'alice@example.test',
  disabledAt: null,
  roleScopes: {},
};
const alina = {
  id: 'alina',
  name: 'Alina',
  username: 'alina',
  email: 'alina@example.test',
  disabledAt: null,
  roleScopes: {},
};
const catalog: AuthorizationOptionsResponse = {
  sections: [],
  recordAccess: [],
  subjectTypes: [],
  collections: [],
};
const projectsRule = {
  key: 'project-default',
  resource: { type: 'composite', id: 'projects' },
  actions: [
    { action: 'view', scopeKey: 'projects', selection: { type: 'all' } },
  ],
};
const calendarRule = {
  key: 'calendar-default',
  resource: { type: 'composite', id: 'calendar' },
  actions: [
    { action: 'view', scopeKey: 'calendar', selection: { type: 'all' } },
  ],
};
interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function expectsLoadingPlaceholder(present: boolean) {
  const placeholder = document.querySelector('[data-slot="loading"]');
  if (present) expect(placeholder).not.toBeNull();
  else expect(placeholder).toBeNull();
}
function Reload({ label }: { readonly label: string }) {
  const { reload } = useOutletContext<{ reload: () => void }>();
  return <button onClick={reload}>{label}</button>;
}

it('keeps the previous user rows visible while a new search is in flight', async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  const calls = vi.fn(
    ({ path, query }: { path: string; query?: Record<string, string> }) => {
      if (path === 'authorization/permissions')
        return { data: { unrestricted: false, permissions: [] } };
      if (path === 'users/options') return options;
      if (query?.q === 'Ali') return pending.promise;
      return { data: [alice], meta: { total: 1 } };
    },
  );
  await renderWithApp(
    <Routes>
      <Route path='/settings/users' element={<UsersPage />} />
    </Routes>,
    {
      route: '/settings/users',
      namespace,
      namespaces,
      services,
      fetch: answerApi(calls),
    },
  );
  expect(await screen.findByText('Alice', { exact: true })).toBeVisible();
  expect(screen.getByText('1 user')).toBeVisible();
  await user.type(
    screen.getByRole('textbox', { name: enUS.settings.userSearch }),
    'Ali',
  );
  await waitFor(() =>
    expect(calls).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'users',
        query: expect.objectContaining({ q: 'Ali' }),
      }),
    ),
  );
  // The refetch keeps the last batch on screen: no loading placeholder replaces it.
  expect(screen.getByText('Alice', { exact: true })).toBeVisible();
  // The table reports the refresh without giving up its rows.
  expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'true');
  expect(screen.queryByText(enUS.listFeedback.loading)).not.toBeInTheDocument();
  expectsLoadingPlaceholder(false);
  // The pagination stays where it is while the rows keep their height.
  expect(screen.getByText('Page 1 of 1')).toBeVisible();
  // The previous total keeps its line but is never presented as the current one.
  expect(screen.getByText('1 user')).toHaveClass('invisible');
  expect(screen.getByText('1 user')).toHaveAttribute('aria-hidden', 'true');
  await act(async () => pending.resolve({ data: [alina], meta: { total: 2 } }));
  await waitFor(() =>
    expect(screen.getByText('Alina', { exact: true })).toBeVisible(),
  );
  expect(screen.queryByText('Alice', { exact: true })).not.toBeInTheDocument();
  expect(screen.getByText('2 users')).toBeVisible();
  expect(screen.getByText('2 users')).not.toHaveClass('invisible');
  expect(screen.getByRole('table')).toHaveAttribute('aria-busy', 'false');
  expect(screen.queryByText(enUS.listFeedback.loading)).not.toBeInTheDocument();
  expectsLoadingPlaceholder(false);
});

it('still shows the loading placeholder on the first load', async () => {
  const pending = deferred<unknown>();
  const calls = vi.fn(({ path }: { path: string }) => {
    if (path === 'authorization/permissions')
      return { data: { unrestricted: false, permissions: [] } };
    if (path === 'users/options') return options;
    return pending.promise;
  });
  await renderWithApp(
    <Routes>
      <Route path='/settings/users' element={<UsersPage />} />
    </Routes>,
    {
      route: '/settings/users',
      namespace,
      namespaces,
      services,
      fetch: answerApi(calls),
    },
  );
  await waitFor(() =>
    expect(calls).toHaveBeenCalledWith(
      expect.objectContaining({ path: 'users' }),
    ),
  );
  expectsLoadingPlaceholder(true);
  expect(screen.queryByText('Alice', { exact: true })).not.toBeInTheDocument();
  await act(async () => pending.resolve({ data: [alice], meta: { total: 1 } }));
  expect(await screen.findByText('Alice', { exact: true })).toBeVisible();
  expectsLoadingPlaceholder(false);
});

it('keeps the previous role rows visible while the list reloads', async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  let reloading = false;
  const calls = vi.fn(({ path }: { path: string }) => {
    if (path === 'authorization/permissions')
      return { data: { unrestricted: true, permissions: [] } };
    if (reloading) return pending.promise;
    return { data: [{ key: 'team', title: 'Team', grants: [] }] };
  });
  await renderWithApp(
    <Routes>
      <Route path='/settings/roles' element={<RolesPage />}>
        <Route index element={<Reload label='Reload roles' />} />
      </Route>
    </Routes>,
    {
      route: '/settings/roles',
      namespace,
      namespaces,
      services,
      fetch: answerApi(calls),
    },
  );
  expect(await screen.findByText('Team', { exact: true })).toBeVisible();
  reloading = true;
  await user.click(screen.getByRole('button', { name: 'Reload roles' }));
  await waitFor(() =>
    expect(
      calls.mock.calls.filter(
        ([call]) => call.path === 'authorization/permissionSets',
      ),
    ).toHaveLength(2),
  );
  expect(screen.getByText('Team', { exact: true })).toBeVisible();
  expect(screen.queryByText(enUS.listFeedback.loading)).not.toBeInTheDocument();
  expectsLoadingPlaceholder(false);
  await act(async () =>
    pending.resolve({ data: [{ key: 'sales', title: 'Sales', grants: [] }] }),
  );
  expect(await screen.findByText('Sales', { exact: true })).toBeVisible();
  expect(screen.queryByText('Team', { exact: true })).not.toBeInTheDocument();
  expectsLoadingPlaceholder(false);
});

it('keeps the previous default access rows visible while the list reloads', async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  let reloading = false;
  const calls = vi.fn(({ path }: { path: string }) => {
    if (path === 'authorization/permissions')
      return { data: { unrestricted: true, permissions: [] } };
    if (path === 'authorization/defaultAccess/options')
      return { data: catalog };
    if (reloading) return pending.promise;
    return { data: [projectsRule] };
  });
  await renderWithApp(
    <Routes>
      <Route path='/settings/default-access' element={<DefaultAccessPage />}>
        <Route index element={<Reload label='Reload default access' />} />
      </Route>
    </Routes>,
    {
      route: '/settings/default-access',
      namespace,
      namespaces,
      services,
      fetch: answerApi(calls),
    },
  );
  expect(await screen.findByText('projects', { exact: true })).toBeVisible();
  reloading = true;
  await user.click(
    screen.getByRole('button', { name: 'Reload default access' }),
  );
  await waitFor(() =>
    expect(
      calls.mock.calls.filter(
        ([call]) => call.path === 'authorization/defaultAccess',
      ),
    ).toHaveLength(2),
  );
  expect(screen.getByText('projects', { exact: true })).toBeVisible();
  expect(screen.queryByText(enUS.listFeedback.loading)).not.toBeInTheDocument();
  expectsLoadingPlaceholder(false);
  await act(async () => pending.resolve({ data: [calendarRule] }));
  await waitFor(() =>
    expect(screen.getByText('calendar', { exact: true })).toBeVisible(),
  );
  expect(
    screen.queryByText('projects', { exact: true }),
  ).not.toBeInTheDocument();
  expectsLoadingPlaceholder(false);
});

function actionsButton(): HTMLElement {
  return screen.getByRole('button', {
    name: 'Actions for Alice',
    expanded: false,
  });
}
function answerUsers(pending: Deferred<unknown>) {
  return vi.fn(
    ({ path, query }: { path: string; query?: Record<string, string> }) => {
      if (path === 'authorization/permissions')
        return { data: { unrestricted: true, permissions: [] } };
      if (path === 'users/options') return options;
      if (query?.q === 'Ali') return pending.promise;
      return { data: [alice], meta: { total: 1 } };
    },
  );
}
async function renderUsers(calls: ReturnType<typeof answerUsers>) {
  await renderWithApp(
    <Routes>
      <Route path='/settings/users' element={<UsersPage />} />
    </Routes>,
    {
      route: '/settings/users',
      namespace,
      namespaces,
      services,
      fetch: answerApi(calls),
    },
  );
}

it('keeps the row actions button mounted across a search refetch', async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  const calls = answerUsers(pending);
  await renderUsers(calls);
  const button = await screen.findByRole('button', {
    name: 'Actions for Alice',
    expanded: false,
  });
  await user.type(
    screen.getByRole('textbox', { name: enUS.settings.userSearch }),
    'Ali',
  );
  await waitFor(() =>
    expect(calls).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'users',
        query: expect.objectContaining({ q: 'Ali' }),
      }),
    ),
  );
  // The pending query must not unmount and remount the row's actions.
  expect(actionsButton()).toBe(button);
  await act(async () => pending.resolve({ data: [alice], meta: { total: 2 } }));
  await waitFor(() => expect(screen.getByText('2 users')).toBeVisible());
  // The response's new data must not remount them either.
  expect(actionsButton()).toBe(button);
});

it('keeps an open confirm dialog across a search refetch', async () => {
  const user = userEvent.setup();
  const pending = deferred<unknown>();
  const calls = answerUsers(pending);
  await renderUsers(calls);
  await user.click(
    await screen.findByRole('button', {
      name: 'Actions for Alice',
      expanded: false,
    }),
  );
  await user.click(
    await screen.findByRole('menuitem', { name: 'Disable', exact: true }),
  );
  const dialog = await screen.findByRole('alertdialog');
  // The modal hides the page from assistive technology; change the box directly.
  fireEvent.change(
    screen.getByRole('textbox', {
      name: enUS.settings.userSearch,
      hidden: true,
    }),
    { target: { value: 'Ali' } },
  );
  await waitFor(() =>
    expect(calls).toHaveBeenCalledWith(
      expect.objectContaining({
        path: 'users',
        query: expect.objectContaining({ q: 'Ali' }),
      }),
    ),
  );
  expect(screen.getByRole('alertdialog')).toBe(dialog);
  await act(async () => pending.resolve({ data: [alice], meta: { total: 2 } }));
  await waitFor(() => expect(screen.getByText('2 users')).toBeVisible());
  // Its state belongs to the row, not to one cell render.
  expect(screen.getByRole('alertdialog')).toBe(dialog);
});
