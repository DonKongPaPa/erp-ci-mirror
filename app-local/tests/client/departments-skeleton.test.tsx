import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import DepartmentsPage from '../../client/pages/settings/departments/index.js';
import { renderAuthenticatedClient } from '../helpers/authenticated-client.js';

/**
 * 加载骨架的几行是并列的兄弟节点，key 必须唯一。2026-11-25 界面检查员在真实应用里看到控制台报
 * `Encountered two children with the same key, w-2/3`：树的骨架用类名当 key，而六行里有两行同宽。
 * 这里断言的是渲染时 React 自己有没有报错，不是源码里的写法。
 *
 * 本机上树接口回得很快，骨架一闪而过 —— 所以把树的请求扣住，等树的骨架确实渲染出来再放行。
 * 页面先显示整页的占位，权限判定回来之后才换成树的骨架，所以要等到树的标题出现。
 */
beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

it('renders the tree loading skeleton without duplicate React keys', async () => {
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await renderAuthenticatedClient(<DepartmentsPage />, {
    route: '/settings/departments',
    beforeRequest: async (request) => {
      if (new URL(request.url).pathname.endsWith('/api/departments/tree')) {
        await gate;
      }
    },
  });
  const wait = { timeout: 30_000 } as const;

  await screen.findByText('Department tree', undefined, wait);
  // 页面上同时有树的骨架与详情的骨架，按「六行」认出树的那一个。
  const treeSkeleton = screen
    .getAllByRole('status')
    .find(
      (element) =>
        element.querySelectorAll('[aria-hidden="true"]').length === 6,
    );
  expect(
    treeSkeleton,
    '树的请求还没回来，树的六行骨架应该显示着',
  ).toBeDefined();
  expect(treeSkeleton).toHaveAttribute('aria-busy', 'true');

  const reported = vi
    .mocked(console.error)
    .mock.calls.filter((args) => String(args[0]).includes('same key'));
  expect(reported.map((args) => String(args[0]).slice(0, 160))).toEqual([]);

  release();
  // 这个服务器里没有部门，树回来之后是空态：等骨架消失就算落定。
  await waitFor(() => expect(screen.queryByRole('status')).toBeNull(), wait);
});
