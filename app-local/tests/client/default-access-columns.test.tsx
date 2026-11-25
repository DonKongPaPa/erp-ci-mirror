import { renderSettingsClient as renderWithApp } from '../helpers/settings-client.js';
import { answerApi } from '@nocobase/app-testing/client';
import { apiClientToken, type ClientApplication } from '@nocobase/app-client';
import {
  AuthorizationClient,
  authorizationClientToken,
  type AuthorizationOptionsResponse,
} from '@nocobase/app-plugin-authorization/client';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useEffect, useState, type ReactElement } from 'react';
import { Route, Routes } from 'react-router';
import { expect, it, vi } from 'vitest';
import DefaultAccessPage from '../../client/pages/settings/default-access.js';
import enUS from '../../client/locales/en-US.js';

const namespace = '@nocobase/default-access-columns-test';
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
const rerenderEvent = 'test:rerender-default-access-parent';

/** Rerenders the page for a reason that has nothing to do with its rows. */
function RerenderingParent(): ReactElement {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((value) => value + 1);
    window.addEventListener(rerenderEvent, bump);
    return () => window.removeEventListener(rerenderEvent, bump);
  }, []);
  return (
    <>
      <span data-testid='rerender-tick'>{tick}</span>
      <DefaultAccessPage />
    </>
  );
}

it('keeps an open row menu across an unrelated rerender', async () => {
  const user = userEvent.setup();
  const calls = vi.fn(({ path }: { path: string }) => {
    if (path === 'authorization/permissions')
      return { data: { unrestricted: true, permissions: [] } };
    if (path === 'authorization/defaultAccess/options')
      return { data: catalog };
    return { data: [projectsRule] };
  });
  await renderWithApp(
    <Routes>
      <Route path='/settings/default-access' element={<RerenderingParent />} />
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
  const trigger = await screen.findByRole('button', {
    name: 'Actions for projects',
    expanded: false,
  });
  await user.click(trigger);
  const menu = await screen.findByRole('menu');
  expect(
    within(menu).getByRole('menuitem', { name: 'View / edit' }),
  ).toBeVisible();

  // No pointer interaction with anything outside the menu: just let the parent
  // render the page again for an unrelated reason.
  expect(screen.getByTestId('rerender-tick')).toHaveTextContent('0');
  fireEvent(window, new Event(rerenderEvent));
  await waitFor(() =>
    expect(screen.getByTestId('rerender-tick')).toHaveTextContent('1'),
  );
  expect(screen.getByText('projects', { exact: true })).toBeVisible();
  // The row's action cell is the same node, and its open menu is still open.
  expect(
    screen.getByRole('button', {
      name: 'Actions for projects',
      expanded: true,
    }),
  ).toBe(trigger);
  expect(screen.getByRole('menu')).toBe(menu);
  expect(
    within(screen.getByRole('menu')).getByRole('menuitem', {
      name: 'View / edit',
    }),
  ).toBeVisible();
});
