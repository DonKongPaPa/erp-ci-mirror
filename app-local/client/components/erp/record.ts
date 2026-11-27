import { ApiClientError } from '@nocobase/app-client';

import { useListData } from '#hooks/use-list-data';
import { useLocation, useResolvedPath } from 'react-router';

/**
 * 读一条记录（详情抽屉、编辑前先读最新数据）。盖在它上面的子路由（编辑对话框）开着时不取数，
 * 关掉时重新取一次；`enabled` 为 `false` 时不发请求（没有读的权限）。
 */
export function useRecord<T>(path: string, enabled = true) {
  const location = useLocation();
  const base = useResolvedPath('.').pathname;
  const active =
    enabled &&
    location.pathname.replace(/\/+$/u, '') === base.replace(/\/+$/u, '');
  const request = useListData<T>(path, { active });
  const notFound =
    request.error instanceof ApiClientError && request.error.status === 404;
  return { ...request, notFound, path };
}
