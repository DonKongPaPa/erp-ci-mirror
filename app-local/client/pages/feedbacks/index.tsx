import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { AlertTriangle, Plus, RefreshCw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';
import { Link, Outlet, useLocation } from 'react-router';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Skeleton } from '#components/ui/skeleton';

import { useFeedbackColumns } from './columns.js';
import { FeedbackClient, type FeedbackListQuery, type FeedbackRow } from './client.js';
import { DiscardControl } from './discard.js';
import { FQC_RESOURCE } from './page-id.js';
import { feedbackErrorText } from './reasons.js';

// min-h 钉住行高：骨架末格是 h-3 骨架块（约 12px），数据末格是 h-7 的操作按钮（约 28px），
// 两态的内容高度不同。共享行类给一个足够容纳按钮的最小高度，替换时每一行 y 都不动（R-026）。
const ROW_CLASS =
  'grid min-h-14 grid-cols-6 items-center gap-2 border-b border-border px-3 py-3 text-sm';
const SKELETON_ROWS = 8;
const PAGE_SIZE = 20;

type StatusFilter = 'all' | 'open' | 'discarded';

interface Filters {
  readonly status: StatusFilter;
  readonly pending: boolean;
  readonly overdue: boolean;
  readonly q: string;
}

function formatTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(date);
}

/**
 * 反馈单列表。页面授权只决定能不能进来；进来之后调哪个端点、显示哪些按钮，
 * 由 `submit` / `maintain` 两个动作决定。等待权限期间先铺骨架，不做首屏位移。
 */
export default function FeedbackListPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const client = useMemo(() => new FeedbackClient(api), [api]);
  const submit = useCan({ resource: FQC_RESOURCE, action: 'submit' });
  const maintain = useCan({ resource: FQC_RESOURCE, action: 'maintain' });
  const columns = useFeedbackColumns();

  const [filters, setFilters] = useState<Filters>({
    status: 'all',
    pending: false,
    overdue: false,
    q: '',
  });
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<readonly FeedbackRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  // 新建与详情是覆盖在这张列表上的子路由，关窗之后父页没有重新挂载：从子路由回到列表时
  // 主动重取一次，刚提交的单才会出现在最上面。
  const location = useLocation();
  const previousPathRef = useRef(location.pathname);
  useEffect(() => {
    const cameFromChild = previousPathRef.current.startsWith('/feedbacks/');
    previousPathRef.current = location.pathname;
    if (cameFromChild && location.pathname === '/feedbacks')
      setReloadToken((value) => value + 1);
  }, [location.pathname]);

  const permissionsReady = !submit.isPending && !maintain.isPending;
  const visible = permissionsReady && (submit.can || maintain.can);

  const load = useCallback(async () => {
    const query: FeedbackListQuery = {
      ...(filters.status === 'all' ? {} : { status: filters.status }),
      ...(maintain.can
        ? {
            ...(filters.pending ? { pending: true } : {}),
            ...(filters.overdue ? { overdue: true } : {}),
            ...(filters.q.trim() ? { q: filters.q.trim() } : {}),
          }
        : {}),
      page,
      pageSize: PAGE_SIZE,
    };
    return maintain.can ? client.list(query) : client.mine(query);
  }, [client, filters, maintain.can, page]);

  useEffect(() => {
    if (!permissionsReady) return;
    if (!visible) return;
    let active = true;
    load().then(
      (result) => {
        if (!active) return;
        setRows(result.items);
        setTotal(result.total);
        setError(undefined);
        setLoading(false);
      },
      (next: unknown) => {
        if (!active) return;
        setError(feedbackErrorText(next, t));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [load, permissionsReady, reloadToken, t, visible]);

  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((value) => value + 1);
  }, []);

  const showSkeleton = !permissionsReady || (visible && loading);

  return (
    <PageContainer>
      <PageHeader
        title={t('navigation.feedbacks')}
        description={t('feedbacks.description')}
        actions={
          <div className='flex items-center gap-2'>
            <Button variant='outline' size='sm' onClick={refresh}>
              <RefreshCw data-icon='inline-start' className='size-4' />
              {t('feedbacks.refresh')}
            </Button>
            {submit.can ? (
              <Button nativeButton={false} render={<Link to='new' />} size='sm'>
                <Plus data-icon='inline-start' className='size-4' />
                {t('feedbacks.new')}
              </Button>
            ) : null}
          </div>
        }
      />

      {!permissionsReady ? null : !visible ? (
        <Card>
          <CardContent className='p-6'>
            <p role='status' className='text-sm text-muted-foreground'>
              {t('feedbacks.noAccess')}
            </p>
          </CardContent>
        </Card>
      ) : (
        <>
          {maintain.can ? (
            <div className='flex flex-wrap items-center gap-2'>
              <label className='flex items-center gap-2 text-sm'>
                {t('feedbacks.filters.status')}
                <Select
                  items={(['all', 'open', 'discarded'] as const).map((value) => ({
                    value,
                    label: t(`feedbacks.filters.status${value === 'all' ? 'All' : value === 'open' ? 'Open' : 'Discarded'}`),
                  }))}
                  value={filters.status}
                  onValueChange={(value) =>
                    setFilters((previous) => ({
                      ...previous,
                      status: value as StatusFilter,
                    }))
                  }
                >
                  <SelectTrigger
                    aria-label={t('feedbacks.filters.status')}
                    className='w-32'
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='all'>{t('feedbacks.filters.statusAll')}</SelectItem>
                    <SelectItem value='open'>{t('feedbacks.filters.statusOpen')}</SelectItem>
                    <SelectItem value='discarded'>{t('feedbacks.filters.statusDiscarded')}</SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <Button
                variant={filters.pending ? 'default' : 'outline'}
                size='sm'
                aria-pressed={filters.pending}
                onClick={() =>
                  setFilters((previous) => ({
                    ...previous,
                    pending: !previous.pending,
                    overdue: previous.pending ? previous.overdue : false,
                  }))
                }
              >
                {t('feedbacks.filters.pending')}
              </Button>
              <Button
                variant={filters.overdue ? 'default' : 'outline'}
                size='sm'
                aria-pressed={filters.overdue}
                onClick={() =>
                  setFilters((previous) => ({
                    ...previous,
                    overdue: !previous.overdue,
                    pending: previous.overdue ? previous.pending : true,
                  }))
                }
              >
                {t('feedbacks.filters.overdue')}
              </Button>
              <Input
                type='search'
                aria-label={t('feedbacks.filters.q')}
                placeholder={t('feedbacks.filters.qPlaceholder')}
                value={filters.q}
                onChange={(event) =>
                  setFilters((previous) => ({ ...previous, q: event.target.value }))
                }
                className='max-w-64'
              />
            </div>
          ) : null}

          {error ? (
            <Alert variant='destructive' role='alert'>
              <AlertTriangle className='size-4' />
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}

          <Card data-testid='feedback-list'>
            <CardHeader className='gap-1'>
              <CardTitle className='text-sm'>
                {maintain.can ? t('feedbacks.all.title') : t('feedbacks.mine.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className='p-0'>
              <div role='table'>
                <div className={ROW_CLASS} role='row'>
                {columns.map((column) => (
                  <span
                    key={column.key}
                    role='columnheader'
                    className='text-xs font-medium text-muted-foreground'
                  >
                    {t(column.labelKey)}
                  </span>
                ))}
                <span role='columnheader' className='sr-only'>
                  {t('feedbacks.list.actions')}
                </span>
              </div>

              {showSkeleton ? (
                <div aria-busy='true'>
                  {Array.from({ length: SKELETON_ROWS }, (_, index) => (
                    <div
                      key={index}
                      data-testid='feedback-skeleton-row'
                      aria-hidden='true'
                      className={ROW_CLASS}
                    >
                      <span className='text-sm text-muted-foreground'>
                        {t('feedbacks.loadingRowLabel')}
                      </span>
                      {columns.slice(1).map((column) => (
                        <Skeleton key={column.key} className='h-3 w-full' />
                      ))}
                      <Skeleton className='h-3 w-8' />
                    </div>
                  ))}
                </div>
              ) : rows.length === 0 ? (
                <p className='p-6 text-sm text-muted-foreground'>
                  {t('feedbacks.empty')}
                </p>
              ) : (
                <ul>
                  {rows.map((item) => (
                    <FeedbackRowItem
                      key={item.id}
                      item={item}
                      columns={columns}
                      canMaintain={maintain.can}
                      locale={locale}
                      client={client}
                      onDiscarded={refresh}
                    />
                  ))}
                </ul>
              )}
              </div>
            </CardContent>
          </Card>

          <div className='flex items-center justify-between text-sm'>
            <span className='text-muted-foreground'>
              {t('feedbacks.total', { count: total })}
            </span>
            <div className='flex items-center gap-2'>
              <Button
                variant='outline'
                size='sm'
                disabled={page <= 1 || loading}
                onClick={() => setPage((value) => Math.max(1, value - 1))}
              >
                {t('feedbacks.prev')}
              </Button>
              <span className='tabular-nums'>{page}</span>
              <Button
                variant='outline'
                size='sm'
                disabled={rows.length < PAGE_SIZE || loading}
                onClick={() => setPage((value) => value + 1)}
              >
                {t('feedbacks.next')}
              </Button>
            </div>
          </div>
        </>
      )}
      <Outlet />
    </PageContainer>
  );
}

function FeedbackRowItem({
  item,
  columns,
  canMaintain,
  locale,
  client,
  onDiscarded,
}: {
  readonly item: FeedbackRow;
  readonly columns: readonly { readonly key: string; readonly labelKey: string }[];
  readonly canMaintain: boolean;
  readonly locale: string;
  readonly client: FeedbackClient;
  readonly onDiscarded: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const cell = (key: string): ReactElement => {
    switch (key) {
      case 'customerName':
        return <span className='truncate'>{item.customerName ?? item.content}</span>;
      case 'productName':
        return <span className='truncate'>{item.productName ?? '-'}</span>;
      case 'batchNo':
        return <span className='truncate'>{item.batchNo ?? '-'}</span>;
      case 'status':
        return (
          <StatusBadge tone={item.status === 'open' ? 'info' : 'neutral'} size='sm'>
            {t(`feedbacks.status.${item.status}`)}
          </StatusBadge>
        );
      case 'createdAt':
        return <span className='text-xs text-muted-foreground'>{formatTime(item.createdAt, locale)}</span>;
      default:
        return <span />;
    }
  };

  return (
    <li data-testid='feedback-row' className='flex flex-col'>
      <div data-testid='feedback-row-cells' className={ROW_CLASS}>
        {columns.map((column) => (
          <div key={column.key}>{cell(column.key)}</div>
        ))}
        <div className='flex items-center justify-end gap-1'>
          <Button
            variant='ghost'
            size='sm'
            aria-expanded={expanded}
            aria-label={t(expanded ? 'feedbacks.list.collapse' : 'feedbacks.list.expand')}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? '−' : '+'}
          </Button>
          {canMaintain && item.canEdit ? (
            <Button nativeButton={false} render={<Link to={item.id} />} size='sm'>
              {t('feedbacks.list.edit')}
            </Button>
          ) : null}
          {canMaintain && item.canDiscard ? (
            <DiscardControl item={item} client={client} onDiscarded={onDiscarded} />
          ) : null}
        </div>
      </div>
      {expanded ? (
        <div className='flex flex-col gap-2 border-b border-border bg-muted/30 px-3 py-3'>
          <p className='whitespace-pre-wrap text-sm leading-6'>{item.content}</p>
          {item.attachments.length > 0 ? (
            <ul className='flex flex-wrap gap-3 text-sm'>
              {item.attachments.map((file) => (
                <li key={file.id}>
                  <a className='underline' href={file.url}>
                    {file.filename}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}
          {canMaintain ? (
            <div className='flex flex-wrap gap-2'>
              <StatusBadge tone='neutral' size='sm'>
                {t('feedbacks.detail.submitter', { name: item.submitterName ?? '-' })}
              </StatusBadge>
              {item.ticket ? (
                <StatusBadge tone='info' size='sm'>
                  {t('feedbacks.detail.ticket', { code: item.ticket.code })}
                </StatusBadge>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
