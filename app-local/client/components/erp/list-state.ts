import { resolveListState, type ListState } from '@nocobase/app-client';
import { useCallback, useMemo } from 'react';

import { useListData } from '#hooks/use-list-data';
import { useListLocation } from '#hooks/use-list-location';
import {
  readTableUrlState,
  useTableUrlState,
} from '#hooks/use-table-url-state';

/** 主数据与单据的列表端点都回这一页的形状（没有 `{ data }` 外层）。 */
export interface EntityPage<T> {
  readonly items: readonly T[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

export interface EntityListOptions {
  /** 端点路径（不含查询串），如 `shifts`、`partners`。 */
  readonly path: string;
  /** 不进地址栏、每次都带的参数，如 `kind=customer`。 */
  readonly fixed?: Readonly<Record<string, string>>;
  /** 地址栏里除搜索、页码、「含已停用」之外的筛选键，如 `status`。 */
  readonly filterKeys?: readonly string[];
  /** 端点没有搜索参数时传 `false`：不读也不写 `q`。 */
  readonly searchable?: boolean;
  /**
   * 「含已停用」怎么传：班次是 `includeInactive=true`；往来单位反过来，不勾时传 `status=active`。
   * `status-all` 给端点认识 `all`（在用加已停用）的列表用：勾了传 `status=all`，不勾仍是 `status=active`。
   */
  readonly inactiveParam?: 'includeInactive' | 'status' | 'status-all';
  /** 没有读的权限时传 `false`：不发请求，列表显示「无权访问」。 */
  readonly enabled?: boolean;
  /** 权限还没落定：先不发请求，列表照常画骨架，不显示「无权访问」。 */
  readonly pending?: boolean;
  readonly defaultPageSize?: number;
}

const PAGE_SIZE_OPTIONS = [10, 20, 50, 100] as const;
const OWN_KEYS = ['q', 'includeInactive', 'page'] as const;
const EMPTY_ROWS: readonly never[] = [];

function compact(
  query: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(query).filter(([, value]) => value !== ''),
  );
}

/** 不勾「含已停用」时端点缺省只回在用；勾上时按端点能接受的写法要求在用加已停用。 */
function inactiveQuery(
  inactiveParam: 'includeInactive' | 'status' | 'status-all',
  includeInactive: boolean,
): Record<string, string> {
  if (inactiveParam === 'includeInactive') {
    return includeInactive ? { includeInactive: 'true' } : {};
  }
  if (inactiveParam === 'status-all') {
    return { status: includeInactive ? 'all' : 'active' };
  }
  return includeInactive ? {} : { status: 'active' };
}

/**
 * 一个列表页的全部取数状态（《基座ERP前端设计》2.1、2.6）：搜索、筛选、每页行数与页码都记在地址栏里，
 * 刷新和后退不丢；改筛选时页码回到第一页；没有排序（端点没有排序参数）。
 *
 * 列表被路由对话框或抽屉盖住时不再取数，关掉时重新取一次（`useListLocation`）。
 */
export function useEntityList<T>({
  path,
  fixed,
  filterKeys = [],
  searchable = true,
  inactiveParam = 'includeInactive',
  enabled = true,
  pending = false,
  defaultPageSize = 20,
}: EntityListOptions) {
  const { params, setParams, active: visible } = useListLocation();
  // 权限还没落定时先不发请求，列表照常画骨架。
  const active = visible && enabled && !pending;
  const q = searchable ? (params.get('q') ?? '') : '';
  const includeInactive = params.get('includeInactive') === 'true';
  const filterKey = filterKeys.join('\u0000');
  const keys = useMemo(
    () => filterKey.split('\u0000').filter(Boolean),
    [filterKey],
  );
  const filters = useMemo(
    () =>
      Object.fromEntries(
        keys.map((key) => [key, params.get(key) ?? '']),
      ) as Record<string, string>,
    [keys, params],
  );
  // 分页先按地址栏读一次（纯函数）拼出请求路径；请求回来后 useTableUrlState 用总数纠正越界的页码。
  const { pageIndex, pageSize } = readTableUrlState(params, {
    defaultPageSize,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    sortColumns: [],
  }).paginationState;
  const fixedKey = JSON.stringify(fixed ?? {});
  const requestPath = useMemo(() => {
    const query = new URLSearchParams(
      compact({
        ...(JSON.parse(fixedKey) as Record<string, string>),
        ...(q ? { q } : {}),
        ...inactiveQuery(inactiveParam, includeInactive),
        ...filters,
      }),
    );
    query.set('page', String(pageIndex + 1));
    query.set('pageSize', String(pageSize));
    return `${path}?${query.toString()}`;
  }, [
    path,
    fixedKey,
    q,
    includeInactive,
    inactiveParam,
    filters,
    pageIndex,
    pageSize,
  ]);
  const request = useListData<EntityPage<T>>(requestPath, {
    keepPreviousData: true,
    active,
  });
  const current = request.path === requestPath;
  const data = request.data;
  const table = useTableUrlState({
    active,
    revision: request.revision,
    defaultPageSize,
    pageSizeOptions: PAGE_SIZE_OPTIONS,
    sortColumns: [],
    // 只在这一次的查询成功到达后才拿总数去纠正页码。
    rowCount:
      enabled && !pending && current && !request.loading && !request.error
        ? data?.total
        : undefined,
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
  /** 改一个筛选：页码回到第一页；空值就把这个键从地址栏去掉。 */
  const setFilter = useCallback(
    (key: string, value: string) =>
      write((next) => {
        next.delete('page');
        if (value) next.set(key, value);
        else next.delete(key);
      }),
    [write],
  );
  const setSearch = useCallback(
    (value: string) => setFilter('q', value),
    [setFilter],
  );
  const setIncludeInactive = useCallback(
    (checked: boolean) => setFilter('includeInactive', checked ? 'true' : ''),
    [setFilter],
  );
  const clearFilters = useCallback(
    () =>
      write((next) => {
        for (const key of [...OWN_KEYS, ...keys]) next.delete(key);
      }),
    [write, keys],
  );

  const filtered =
    Boolean(q) || includeInactive || Object.values(filters).some(Boolean);
  const rows = data?.items ?? EMPTY_ROWS;
  const total = data?.total ?? 0;
  const listState: ListState =
    !enabled && !pending
      ? 'forbidden'
      : resolveListState(
          {
            data,
            error: table.error ?? request.error,
            isPending: request.loading && data === undefined,
          },
          total,
          filtered,
        );

  return {
    rows,
    total,
    /** 这一次请求的地址，给表格当加载反馈的标识。 */
    requestPath,
    loading: request.loading,
    listState,
    /** 第一次加载：画骨架行，不画「加载中」。 */
    skeleton: listState === 'loading',
    filtered,
    /** 有搜索或可展开的筛选的列表才有「清空筛选」；只有「含已停用」的直接取消勾选。 */
    clearable: searchable || filterKeys.length > 0,
    q,
    includeInactive,
    filters,
    setSearch,
    setFilter,
    setIncludeInactive,
    clearFilters,
    reload: request.reload,
    replaceData: request.replaceData,
    paginationState: table.paginationState,
    onPaginationChange: table.onPaginationChange,
    pageSizeOptions: table.pageSizeOptions,
    /** 展开进 DataTable：端点没有排序参数，任何列都不画排序。 */
    sortableColumns: table.sortableColumns,
  };
}
