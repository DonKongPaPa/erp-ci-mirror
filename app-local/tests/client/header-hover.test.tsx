import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AppThemeProvider } from '../../client/theme/theme-provider';
import { HeaderActions } from '../../client/layouts/components/header-actions';
import { UserMenu } from '../../client/layouts/components/user-menu';
import {
  allowHoverAfterOverlayClose,
  suppressHoverAfterOverlayClose,
} from '../../client/lib/overlay-hover-guard.js';

import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

beforeEach(() => {
  // jsdom does not implement the media queries used by the real theme provider.
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addListener() {},
    removeListener() {},
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  document.documentElement.removeAttribute('class');
  document.documentElement.removeAttribute('style');
  document.documentElement.removeAttribute('data-theme');
});

const panels = [['Open account menu', UserMenu, 'menu']] as const;

it.each(panels)(
  'opens and closes %s on hover',
  async (label, Component, role) => {
    const user = userEvent.setup();
    await renderAuthenticatedClient(
      <AppThemeProvider>
        <Component />
      </AppThemeProvider>,
    );
    const trigger = screen.getByRole('button', { name: label });

    await user.hover(trigger);
    // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
    const panel = screen.getByRole(role);
    expect(trigger).not.toHaveAttribute('title');
    // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
    // Supply the destination because user-event does not set relatedTarget.
    fireEvent.mouseLeave(trigger, { relatedTarget: panel });
    fireEvent.mouseEnter(panel, { relatedTarget: trigger });
    fireEvent.mouseMove(panel);
    expect(panel).toBeVisible();

    fireEvent.mouseLeave(panel, { relatedTarget: document.body });
    fireEvent.mouseMove(document.body, { clientX: 1000, clientY: 1000 });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  },
);

it.each(panels)(
  'opens %s by keyboard and closes with Escape',
  async (label, Component, role) => {
    const user = userEvent.setup();
    await renderAuthenticatedClient(
      <AppThemeProvider>
        <Component />
      </AppThemeProvider>,
    );
    const trigger = screen.getByRole('button', { name: label });

    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');
    // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
    expect(screen.getByRole(role)).toBeVisible();
    await user.keyboard('{Escape}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  },
);

it('offers appearance only inside the account menu with keyboard selection', async () => {
  const user = userEvent.setup();
  await renderAuthenticatedClient(
    <AppThemeProvider>
      <HeaderActions />
    </AppThemeProvider>,
  );
  expect(
    screen.queryByRole('button', { name: 'Theme' }),
  ).not.toBeInTheDocument();
  // The inbox entry comes before the account menu in the header.
  await user.tab();
  // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
  expect(screen.getByRole('link', { name: /inbox/i })).toHaveFocus();
  await user.tab();
  await user.keyboard('{Enter}');
  // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
  const appearance = screen.getByRole('menuitem', { name: 'Theme' });
  appearance.focus();
  await user.keyboard('{ArrowRight}');
  // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
  expect(screen.getAllByRole('menuitemradio')).toHaveLength(5);
  await user.keyboard('{ArrowDown}{Enter}');
  expect(document.documentElement).toHaveClass('dark');
  // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
  expect(screen.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await user.keyboard('{Escape}');
  expect(appearance).toHaveFocus();
  // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
  expect(screen.getByRole('menuitem', { name: 'Sign out' })).toBeVisible();
  await user.keyboard('{Escape}');
  expect(
    // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
    screen.getByRole('button', { name: 'Open account menu' }),
  ).toHaveFocus();
});

it('does not open the account menu from the hover a closing overlay leaves behind', async () => {
  const user = userEvent.setup();
  // A closing drawer's X sits exactly over the account button. jsdom cannot
  // re-hit-test the page when the panel unmounts, so the test drives the guard
  // the close button arms directly: hover must not open the menu while it is
  // armed, and must work again once the pointer leaves the trigger.
  suppressHoverAfterOverlayClose(60_000);
  try {
    await renderAuthenticatedClient(
      <AppThemeProvider>
        <HeaderActions />
      </AppThemeProvider>,
    );
    const trigger = screen.getByRole('button', { name: 'Open account menu' });

    await user.hover(trigger);
    // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    // A click-through would arrive as a trigger press, not a hover; it must not
    // open the menu either.
    await user.click(trigger);
    // eslint-disable-next-line app-local/no-sync-query-after-action -- 同步可得的元素，动作已 await；异步元素请用 findBy/waitFor（R-047 行内豁免）
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();

    await user.unhover(trigger);
    await user.hover(trigger);
    expect(await screen.findByRole('menu')).toBeVisible();
  } finally {
    allowHoverAfterOverlayClose();
  }
});
