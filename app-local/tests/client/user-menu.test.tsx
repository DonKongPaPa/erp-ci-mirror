import { AppThemeProvider } from '../../client/theme/index.js';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';

import { UserMenu } from '../../client/layouts/components/user-menu.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

// jsdom has no media queries; the real account menu includes the theme provider.
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
});

it('uses CJK name endings in the avatar while retaining the full account name and picture', async () => {
  const view = await renderAuthenticatedClient(
    <AppThemeProvider>
      <UserMenu />
    </AppThemeProvider>,
  );
  const user = userEvent.setup();
  const trigger = screen.getByRole('button', { name: 'Open account menu' });
  await user.tab();
  for (const [name, expected] of [
    ['周建国', '建国'],
    ['欧阳娜娜', '娜娜'],
    ['李雷', '李雷'],
    ['周 建国', '建国'],
    ['Li Lei', 'LL'],
    ['周', '周'],
  ] as const) {
    await act(async () => {
      const response = await view.identity().client.updateUser({ name });
      expect(response.error).toBeNull();
      await view.identity().refresh();
    });
    expect(trigger).toHaveTextContent(expected);
    await user.keyboard('{Enter}');
    expect(
      // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
      within(screen.getByRole('menu')).getByText(name, { exact: true }),
    ).toBeVisible();
    await user.keyboard('{Escape}');
  }
  await act(async () => {
    const response = await view.identity().client.updateUser({ name: '' });
    expect(response.error).toBeNull();
    await view.identity().refresh();
  });
  expect(trigger).toHaveTextContent(view.session.user.email[0]!.toUpperCase());
  await act(async () => {
    const response = await view
      .identity()
      .client.updateUser({ image: 'https://example.test/avatar.png' });
    expect(response.error).toBeNull();
    await view.identity().refresh();
  });
  expect(trigger.querySelector('img')).toHaveAttribute(
    'src',
    'https://example.test/avatar.png',
  );
  expect(trigger).not.toHaveTextContent('周');
});

it('R-032: puts the API keys entry in the account menu for every signed-in user', async () => {
  await renderAuthenticatedClient(
    <AppThemeProvider>
      <UserMenu />
    </AppThemeProvider>,
  );
  const user = userEvent.setup();
  await user.tab();
  await user.keyboard('{Enter}');
  const entry = await screen.findByRole('menuitem', { name: 'API keys' });
  // 部署前缀由运行时给出，链接里只钉页面自己的地址。
  expect(entry.getAttribute('href')).toMatch(/\/account\/api-keys$/u);
});
