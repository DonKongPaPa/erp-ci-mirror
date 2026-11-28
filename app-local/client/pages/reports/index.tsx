import { resolveListState, useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { useSearchParams } from 'react-router';

import { DataTable } from '#components/data-table';
import { ListPage } from '#components/erp/list-page';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card';
import { Checkbox } from '#components/ui/checkbox';
import { Input } from '#components/ui/input';

import {
  formatCell,
  REPORT_CATEGORIES,
  type ReportBrief,
  type ReportColumn,
  type ReportResult,
  type ReportSchema,
  type RunReportInput,
} from './model.js';

/** 报表资源上的四个入口动作；每张报表的 baseActions 与列动作由服务端再裁一次。 */
const entry = (action: string) => ({
  resource: { type: 'composite', id: 'reports' },
  action,
}) as const;

interface Keyed<T> {
  readonly key: string;
  readonly value: T;
}

/**
 * R-078 报表中心通用页：左侧按四组列服务端给得起的报表，右侧一份通用表单。
 * 筛选、维度、度量的键全部来自 schema；没有动作就不发对应请求，也不画对应按钮。
 * schema 与结果都带报表 key：切表时不先显示上一张的残留，也不必在 effect 里同步清状态。
 */
export default function ReportsPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const selectedKey = searchParams.get('key');
  const view = useCan(entry('view'));
  const run = useCan(entry('run'));
  const exportAllowed = useCan(entry('export'));
  const favorite = useCan(entry('favorite'));

  const [items, setItems] = useState<readonly ReportBrief[]>([]);
  const [favorites, setFavorites] = useState<readonly string[]>([]);
  const [listPending, setListPending] = useState(true);
  const [schema, setSchema] = useState<Keyed<ReportSchema> | null>(null);
  const [schemaErrorKey, setSchemaErrorKey] = useState<string | null>(null);
  const [filters, setFilters] = useState<Readonly<Record<string, string>>>({});
  const [dimensions, setDimensions] = useState<readonly string[]>([]);
  const [measures, setMeasures] = useState<readonly string[]>([]);
  const [pageState, setPageState] = useState({ pageIndex: 0, pageSize: 20 });
  const [result, setResult] = useState<Keyed<ReportResult> | null>(null);
  const [running, setRunning] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [favoriting, setFavoriting] = useState(false);
  const [resultError, setResultError] = useState<unknown>();

  useEffect(() => {
    if (view.isPending || !view.can) return;
    const controller = new AbortController();
    void Promise.all([
      api.request<{ items: readonly ReportBrief[] }>({
        path: 'reports', signal: controller.signal,
      }),
      api.request<{ items: readonly ReportBrief[] }>({
        path: 'reports/favorites', signal: controller.signal,
      }),
    ])
      .then(([list, fav]) => {
        if (controller.signal.aborted) return;
        setItems(list.items);
        setFavorites(fav.items.map((item) => item.key));
      })
      .catch(() => {
        if (!controller.signal.aborted) setSchemaErrorKey('reports');
      })
      .finally(() => {
        if (!controller.signal.aborted) setListPending(false);
      });
    return () => controller.abort();
  }, [api, view.isPending, view.can]);

  useEffect(() => {
    if (selectedKey === null || view.isPending || !view.can) return;
    const controller = new AbortController();
    void api
      .request<ReportSchema>({
        path: `reports/${encodeURIComponent(selectedKey)}/schema`,
        signal: controller.signal,
      })
      .then((next) => {
        if (controller.signal.aborted) return;
        setSchema({ key: selectedKey, value: next });
        setSchemaErrorKey(null);
        setFilters({});
        setDimensions([...next.dimensions]);
        setMeasures([...next.measures]);
        setPageState({ pageIndex: 0, pageSize: 20 });
        setResult(null);
      })
      .catch(() => {
        if (!controller.signal.aborted) setSchemaErrorKey(selectedKey);
      });
    return () => controller.abort();
  }, [api, selectedKey, view.isPending, view.can]);

  const activeSchema = schema?.key === selectedKey ? schema.value : null;
  const activeResult = result?.key === selectedKey ? result.value : null;
  const schemaPending = selectedKey !== null && activeSchema === null && schemaErrorKey !== selectedKey;

  const inputOf = (pageIndex: number, pageSize: number): RunReportInput => ({
    filters: Object.fromEntries(
      Object.entries(filters).filter(([, value]) => value.trim() !== ''),
    ),
    dimensions: [...dimensions],
    measures: [...measures],
    page: pageIndex + 1,
    pageSize,
  });

  const generate = async (pageIndex: number, pageSize: number): Promise<void> => {
    if (selectedKey === null) return;
    setRunning(true);
    setResultError(undefined);
    try {
      const next = await api.request<ReportResult>({
        path: `reports/${encodeURIComponent(selectedKey)}/run`,
        method: 'POST',
        json: inputOf(pageIndex, pageSize),
      });
      setResult({ key: selectedKey, value: next });
    } catch (cause: unknown) {
      setResultError(cause);
    } finally {
      setRunning(false);
    }
  };

  const download = async (): Promise<void> => {
    if (selectedKey === null) return;
    setExporting(true);
    try {
      const csv = await api.request<string>({
        path: `reports/${encodeURIComponent(selectedKey)}/export`,
        method: 'POST',
        json: inputOf(0, 100),
      });
      const url = URL.createObjectURL(
        new Blob([csv], { type: 'text/csv;charset=utf-8' }),
      );
      const link = document.createElement('a');
      link.href = url;
      link.download = `${selectedKey}.csv`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL?.(url);
    } finally {
      setExporting(false);
    }
  };

  const toggleFavorite = async (): Promise<void> => {
    if (selectedKey === null) return;
    setFavoriting(true);
    const wasFavorite = favorites.includes(selectedKey);
    try {
      await api.request<{ favorited: boolean }>({
        path: `reports/${encodeURIComponent(selectedKey)}/favorite`,
        method: wasFavorite ? 'DELETE' : 'POST',
      });
      setFavorites((current) =>
        wasFavorite
          ? current.filter((key) => key !== selectedKey)
          : [...current, selectedKey],
      );
    } finally {
      setFavoriting(false);
    }
  };

  const columns = useMemo<ColumnDef<Record<string, string | number | null>>[]>(
    () =>
      (activeResult?.columns ?? []).map((column: ReportColumn) => ({
        id: column.key,
        header: t(column.labelKey),
        cell: ({ row }) => (
          <span
            className={
              column.type === 'number'
                ? 'block text-right tabular-nums'
                : 'block break-words'
            }
          >
            {formatCell(row.original[column.key], column.type, i18n.language)}
          </span>
        ),
      })),
    [activeResult, t, i18n.language],
  );

  const toggle = (
    key: string,
    values: readonly string[],
    setValues: (next: readonly string[]) => void,
  ): void =>
    setValues(
      values.includes(key) ? values.filter((item) => item !== key) : [...values, key],
    );

  return (
    <ListPage title={t('reports.title')} description={t('reports.description')}>
      {view.isPending ? <p className='text-sm'>{t('reports.loading')}</p> : null}
      {!view.isPending && !view.can ? (
        <p role='alert' className='text-sm text-destructive'>
          {t('reports.denied')}
        </p>
      ) : (
        <div className='flex flex-col gap-4 md:flex-row'>
          <nav
            aria-label={t('reports.groups.title')}
            className='flex flex-col gap-4 md:w-56 md:shrink-0'
          >
            {REPORT_CATEGORIES.map((category) => {
              const group = items.filter((item) => item.category === category);
              if (group.length === 0) return null;
              return (
                <section key={category} className='flex flex-col gap-1'>
                  <h2 className='text-sm font-medium'>
                    {t(`reports.groups.${category}`)}
                  </h2>
                  {group.map((item) => (
                    <Button
                      key={item.key}
                      variant={item.key === selectedKey ? 'secondary' : 'ghost'}
                      className='justify-start text-left text-sm'
                      onClick={() =>
                        setSearchParams({ key: item.key }, { replace: false })
                      }
                    >
                      <span className='min-w-0 truncate'>{t(item.titleKey)}</span>
                    </Button>
                  ))}
                </section>
              );
            })}
            {!listPending && items.length === 0 ? (
              <p className='text-sm text-muted-foreground'>
                {t('reports.noReports')}
              </p>
            ) : null}
          </nav>

          <div className='flex min-w-0 flex-1 flex-col gap-4'>
            {selectedKey === null ? (
              <Card>
                <CardContent className='text-sm text-muted-foreground'>
                  {t('reports.empty')}
                </CardContent>
              </Card>
            ) : null}
            {selectedKey !== null && schemaPending ? (
              <p className='text-sm'>{t('reports.loading')}</p>
            ) : null}
            {selectedKey !== null && schemaErrorKey === selectedKey ? (
              <p role='alert' className='text-sm text-destructive'>
                {t('reports.loadFailed')}
              </p>
            ) : null}
            {selectedKey !== null && activeSchema !== null ? (
              <>
                <Card>
                  <CardHeader className='flex flex-col gap-1'>
                    <CardTitle className='text-base'>
                      {t(`reporting.titles.${selectedKey}`)}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className='flex flex-col gap-4'>
                    <fieldset className='flex flex-col gap-2'>
                      <legend className='text-sm font-medium'>
                        {t('reports.filters')}
                      </legend>
                      {activeSchema.dimensions.map((dimension) => (
                        <div key={dimension} className='flex flex-col gap-1'>
                          <label
                            htmlFor={`filter-${dimension}`}
                            className='text-xs text-muted-foreground'
                          >
                            {t(`reporting.columns.${dimension}`)}
                          </label>
                          <Input
                            id={`filter-${dimension}`}
                            data-testid={`filter-${dimension}`}
                            value={filters[dimension] ?? ''}
                            onChange={(event) =>
                              setFilters({
                                ...filters,
                                [dimension]: event.target.value,
                              })
                            }
                          />
                        </div>
                      ))}
                    </fieldset>
                    <fieldset className='flex flex-col gap-2'>
                      <legend className='text-sm font-medium'>
                        {t('reports.dimensions')}
                      </legend>
                      {activeSchema.dimensions.map((dimension) => (
                        <label key={dimension} className='flex items-center gap-2 text-sm'>
                          <Checkbox
                            data-testid={`dimension-${dimension}`}
                            checked={dimensions.includes(dimension)}
                            onCheckedChange={() =>
                              toggle(dimension, dimensions, setDimensions)
                            }
                          />
                          {t(`reporting.columns.${dimension}`)}
                        </label>
                      ))}
                    </fieldset>
                    <fieldset className='flex flex-col gap-2'>
                      <legend className='text-sm font-medium'>
                        {t('reports.measures')}
                      </legend>
                      {activeSchema.measures.map((measure) => (
                        <label key={measure} className='flex items-center gap-2 text-sm'>
                          <Checkbox
                            data-testid={`measure-${measure}`}
                            checked={measures.includes(measure)}
                            onCheckedChange={() =>
                              toggle(measure, measures, setMeasures)
                            }
                          />
                          {t(`reporting.columns.${measure}`)}
                        </label>
                      ))}
                    </fieldset>
                    <div className='flex flex-wrap gap-2'>
                      {run.can ? (
                        <PendingButton
                          busy={running}
                          onClick={() =>
                            void generate(pageState.pageIndex, pageState.pageSize)
                          }
                        >
                          {t('reports.generate')}
                        </PendingButton>
                      ) : null}
                      {exportAllowed.can ? (
                        <PendingButton busy={exporting} variant='outline' onClick={() => void download()}>
                          {t('reports.export')}
                        </PendingButton>
                      ) : null}
                      {favorite.can ? (
                        <PendingButton
                          busy={favoriting}
                          variant='outline'
                          onClick={() => void toggleFavorite()}
                        >
                          {t(
                            favorites.includes(selectedKey)
                              ? 'reports.unfavorite'
                              : 'reports.favorite',
                          )}
                        </PendingButton>
                      ) : null}
                    </div>
                  </CardContent>
                </Card>

                <section data-testid='reports-result' className='flex flex-col gap-2'>
                  <h2 className='text-base font-medium'>{t('reports.result')}</h2>
                  {resultError !== undefined ? (
                    <p role='alert' className='text-sm text-destructive'>
                      {t('reports.runFailed')}
                    </p>
                  ) : null}
                  <DataTable<Record<string, string | number | null>>
                    columns={columns}
                    data={activeResult?.items ?? []}
                    manualPagination
                    rowCount={activeResult?.total ?? 0}
                    paginationState={pageState}
                    onPaginationChange={(updater) => {
                      const next =
                        typeof updater === 'function' ? updater(pageState) : updater;
                      setPageState(next);
                      void generate(next.pageIndex, next.pageSize);
                    }}
                    pageSizeOptions={[20, 50, 100]}
                    loading={running}
                    listState={resolveListState(
                      { data: activeResult, error: resultError, isPending: running },
                      activeResult?.items.length ?? 0,
                    )}
                    onRetry={() => void generate(pageState.pageIndex, pageState.pageSize)}
                    emptyMessage={t('reports.emptyResult')}
                    showSelectedCount={false}
                  />
                </section>
              </>
            ) : null}
          </div>
        </div>
      )}
    </ListPage>
  );
}
