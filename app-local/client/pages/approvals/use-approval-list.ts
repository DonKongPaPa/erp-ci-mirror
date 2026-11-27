import { resolveListState } from '@nocobase/app-client';
import { useCallback, useMemo } from 'react';

import { useListData } from '#hooks/use-list-data';
import { useListLocation } from '#hooks/use-list-location';
import {
  readTableUrlState,
  useTableUrlState,
} from '#hooks/use-table-url-state';

/** 审批列表只用自己的查询串：页签、页码、关键字、排序都在地址栏里。 */
const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const EMPTY_ROWS: readonly never[] = [];

export function useApprovalList<T>({
  path,
  scopes,
  sortColumns,
  enabled = true,
}: {
  readonly path: string;
  readonly scopes: readonly string[];
  readonly sortColumns: readonly string[];
  readonly enabled?: boolean;
}) {
  const { params, setParams, active: located } = useListLocation();
  const active = located && enabled;
  const rawScope = params.get('scope') ?? '';
  const scope = scopes.includes(rawScope) ? rawScope : (scopes[0] ?? '');
  const q = params.get('q') ?? '';
  const read = readTableUrlState(params, {
    defaultPageSize: 20,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    sortColumns,
    defaultSorting: [{ id: 'createdAt', desc: true }],
  });
  const page = read.paginationState.pageIndex + 1;
  const pageSize = read.paginationState.pageSize;
  const sortId = read.sortingState[0]?.id;
  const sortDir = read.sortingState[0]?.desc ? 'desc' : 'asc';
  const requestPath = useMemo(() => {
    const query = new URLSearchParams({ scope, page: String(page), pageSize: String(pageSize) });
    if (q) query.set('q', q);
    if (sortId) {
      query.set('sortBy', sortId);
      query.set('sortDir', sortDir);
    }
    return `${path}?${query.toString()}`;
  }, [path, scope, q, page, pageSize, sortId, sortDir]);
  const request = useListData<{ data: readonly T[]; meta: { total: number } }>(
    requestPath,
    { keepPreviousData: true, active },
  );
  const current = request.path === requestPath;
  const table = useTableUrlState({
    active,
    revision: request.revision,
    defaultPageSize: 20,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    sortColumns,
    defaultSorting: [{ id: 'createdAt', desc: true }],
    rowCount:
      current && !request.loading && !request.error ? request.data?.meta.total : undefined,
  });

  const write = useCallback(
    (change: (next: URLSearchParams) => void) => {
      setParams(
        (old) => {
          const next = new URLSearchParams(old);
          change(next);
          return next;
        },
        { replace: true },
      );
    },
    [setParams],
  );
  const setScope = useCallback(
    (next: string) =>
      write((params) => {
        params.delete('page');
        params.set('scope', next);
      }),
    [write],
  );
  const setSearch = useCallback(
    (value: string) =>
      write((params) => {
        params.delete('page');
        if (value) params.set('q', value);
        else params.delete('q');
      }),
    [write],
  );
  const clearFilters = useCallback(
    () =>
      write((params) => {
        for (const key of ['q', 'page', 'scope', 'sort', 'order'])
          params.delete(key);
      }),
    [write],
  );

  const total = request.data?.meta.total ?? 0;
  const filtered = Boolean(q) || scope !== scopes[0];
  const listState = resolveListState(
    {
      data: current ? request.data : undefined,
      error: table.error ?? request.error,
      isPending: request.loading && !current,
    },
    total,
    filtered,
  );

  return {
    scope,
    q,
    rows: (current ? request.data?.data : undefined) ?? EMPTY_ROWS,
    total,
    requestPath,
    loading: request.loading,
    listState,
    skeleton: listState === 'loading',
    filtered,
    setScope,
    setSearch,
    clearFilters,
    reload: request.reload,
    paginationState: table.paginationState,
    onPaginationChange: table.onPaginationChange,
    pageSizeOptions: table.pageSizeOptions,
    sortableColumns: table.sortableColumns,
    sortingState: table.sortingState,
    onSortingChange: table.onSortingChange,
  };
}
