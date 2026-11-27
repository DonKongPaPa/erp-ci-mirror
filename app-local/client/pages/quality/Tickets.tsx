import { useApiClient } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { Inbox, Loader2, Search } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Skeleton } from '#components/ui/skeleton';
import { StatusBadge } from '#components/status-badge';

import { QualityClient, type QualityTicket } from './client.js';
import { formatTime } from './format.js';
import { severityTone } from './tones.js';
import { transitionNames } from './model.js';
import {
  AcceptDialog,
  CloseDialog,
  ReopenDialog,
  ResolveDialog,
} from './TicketActions.js';
import { TicketDetailDialog } from './TicketDetail.js';
import { useDepartmentOptions } from './use-departments.js';

const STATES = ['open', 'in_progress', 'resolved', 'reopened', 'closed'] as const;
const ALL = 'all';
const PAGE_SIZE = 50;

interface TicketFilters {
  readonly state: string;
  readonly departmentId: string;
  readonly assigneeId: string;
  readonly q: string;
}

const DEFAULT_FILTERS: TicketFilters = {
  state: ALL,
  departmentId: ALL,
  assigneeId: ALL,
  q: '',
};

const isDefault = (filters: TicketFilters): boolean =>
  filters.state === ALL &&
  filters.departmentId === ALL &&
  filters.assigneeId === ALL &&
  filters.q.trim() === '';

/**
 * 工单卡（R-003 验收 17）：列表带状态、责任部门、经办人筛选与只按编号标题的搜索，
 * 行里的受理、解决、关闭、重开按钮跟着服务端算好的 `canTransition` 走，
 * 详情里能改判、能看相似工单。
 *
 * 默认筛选下显示页面级取回的行（统计与部门分流共用同一份数据，不发两次请求）；
 * 筛选一旦偏离默认，这里自己按条件取一次，只替换显示的行，不动统计。
 */
export function TicketsCard({
  rows,
  loading,
  client: providedClient,
  onChanged,
}: {
  /** 页面级取回的工单（未筛选的前 50 条）。 */
  readonly rows: readonly QualityTicket[];
  readonly loading: boolean;
  readonly client?: QualityClient;
  /** 任一动作成功之后回调：父级刷新页面级的数据。 */
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const client = useMemo(
    () => providedClient ?? new QualityClient(api),
    [providedClient, api],
  );
  const [filters, setFilters] = useState<TicketFilters>(DEFAULT_FILTERS);
  const [filteredRows, setFilteredRows] = useState<readonly QualityTicket[]>([]);
  const [filteredLoading, setFilteredLoading] = useState(false);
  const [detailId, setDetailId] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);

  const active = !isDefault(filters);
  const { options: departmentOptions } = useDepartmentOptions(client, true);

  // 筛选只在事件里改：改的同时清掉上一轮的筛选结果并进入加载态，
  // 随后的 effect 只负责按条件取数，不在自己的身体里 setState。
  const applyFilters = useCallback((next: TicketFilters) => {
    setFilters(next);
    if (isDefault(next)) {
      setFilteredRows([]);
      setFilteredLoading(false);
      return;
    }
    setFilteredRows([]);
    setFilteredLoading(true);
  }, []);

  useEffect(() => {
    if (!active) return;
    let activeRequest = true;
    client
      .listTickets({
        ...(filters.state === ALL ? {} : { state: filters.state }),
        ...(filters.departmentId === ALL
          ? {}
          : { departmentId: filters.departmentId }),
        ...(filters.assigneeId === ALL ? {} : { assigneeId: filters.assigneeId }),
        ...(filters.q.trim() === '' ? {} : { q: filters.q.trim() }),
        page: 1,
        pageSize: PAGE_SIZE,
      })
      .then(
        (result) => {
          if (!activeRequest) return;
          setFilteredRows(result.items);
          setFilteredLoading(false);
        },
        () => {
          if (!activeRequest) return;
          // 筛选取不到就退回未筛选的行：筛选是辅助视图，不打断主列表。
          setFilteredRows([]);
          setFilteredLoading(false);
        },
      );
    return () => {
      activeRequest = false;
    };
  }, [active, client, filters, reloadToken]);

  const displayed = active ? filteredRows : rows;
  const displayLoading = active ? filteredLoading : loading;

  // 经办人筛选取自已加载的行里出现过的（标识 + 姓名）对：不额外拉人名单。
  const assigneeOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const ticket of rows) {
      if (ticket.assigneeId && ticket.assigneeName) {
        map.set(ticket.assigneeId, ticket.assigneeName);
      }
    }
    return [...map.entries()].map(([id, name]) => ({ id, name }));
  }, [rows]);

  const refreshFiltered = useCallback(() => {
    if (active) setReloadToken((value) => value + 1);
  }, [active]);

  return (
    <Card data-testid='tickets-card'>
      <CardHeader>
        <CardTitle className='flex items-center gap-2 text-sm'>
          <Inbox className='size-4' />
          {t('quality.tickets.title')}
        </CardTitle>
        <CardDescription>
          {t('quality.tickets.count', { count: displayed.length })}
        </CardDescription>
      </CardHeader>
      <CardContent className='p-0'>
        <div className='flex flex-wrap items-center gap-2 px-4 pt-4 pb-2'>
          <label className='flex items-center gap-2 text-sm'>
            {t('quality.tickets.filters.state')}
            <Select
              items={[ALL, ...STATES].map((value) => ({
                value,
                label:
                  value === ALL
                    ? t('quality.tickets.filters.all')
                    : t(`quality.states.${value}`),
              }))}
              value={filters.state}
              onValueChange={(value) =>
                applyFilters({
                  ...filters,
                  state: value as string,
                })
              }
            >
              <SelectTrigger
                aria-label={t('quality.tickets.filters.state')}
                className='w-32'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t('quality.tickets.filters.all')}
                </SelectItem>
                {STATES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`quality.states.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <label className='flex items-center gap-2 text-sm'>
            {t('quality.tickets.filters.department')}
            <Select
              items={[ALL, ...departmentOptions].map((option) => ({
                value: typeof option === 'string' ? option : option.id,
                label:
                  typeof option === 'string'
                    ? t('quality.tickets.filters.departmentAll')
                    : option.title,
              }))}
              value={filters.departmentId}
              onValueChange={(value) =>
                applyFilters({
                  ...filters,
                  departmentId: value as string,
                })
              }
            >
              <SelectTrigger
                aria-label={t('quality.tickets.filters.department')}
                className='w-40'
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>
                  {t('quality.tickets.filters.departmentAll')}
                </SelectItem>
                {departmentOptions.map((option) => (
                  <SelectItem key={option.id} value={option.id}>
                    {option.title}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          {assigneeOptions.length > 0 ? (
            <label className='flex items-center gap-2 text-sm'>
              {t('quality.tickets.filters.assignee')}
              <Select
                items={[ALL, ...assigneeOptions].map((option) => ({
                  value: typeof option === 'string' ? option : option.id,
                  label:
                    typeof option === 'string'
                      ? t('quality.tickets.filters.assigneeAll')
                      : option.name,
                }))}
                value={filters.assigneeId}
                onValueChange={(value) =>
                  applyFilters({
                    ...filters,
                    assigneeId: value as string,
                  })
                }
              >
                <SelectTrigger
                  aria-label={t('quality.tickets.filters.assignee')}
                  className='w-32'
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL}>
                    {t('quality.tickets.filters.assigneeAll')}
                  </SelectItem>
                  {assigneeOptions.map((option) => (
                    <SelectItem key={option.id} value={option.id}>
                      {option.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          ) : null}
          <Input
            type='search'
            aria-label={t('quality.tickets.filters.q')}
            placeholder={t('quality.tickets.filters.qPlaceholder')}
            value={filters.q}
            onChange={(event) =>
              applyFilters({ ...filters, q: event.target.value })
            }
            className='max-w-56'
          />
          {active ? (
            <Button
              variant='ghost'
              size='sm'
              data-testid='tickets-filter-clear'
              onClick={() => applyFilters(DEFAULT_FILTERS)}
            >
              {t('quality.tickets.filters.clear')}
            </Button>
          ) : null}
        </div>
        {displayLoading && displayed.length === 0 ? (
          // 占位与真实列表同量级：加载时下方卡片不在视口内，数据到了也不会被
          // 一个约 5000 像素长的列表顶出去（首屏那一次 0.12 的位移）。
          <div
            data-testid='ticket-loading'
            aria-busy='true'
            className='min-h-96'
          >
            <div className='flex items-center gap-2 p-6 text-sm text-muted-foreground'>
              <Loader2 className='size-4 animate-spin' />
              {t('quality.loading')}
            </div>
            <div aria-hidden='true' className='divide-y divide-border'>
              {Array.from({ length: 8 }, (_, index) => (
                <div
                  key={index}
                  data-testid='ticket-loading-row'
                  className='flex flex-col gap-2 p-4'
                >
                  <Skeleton className='h-5 w-2/3' />
                  <Skeleton className='h-4 w-full' />
                  <Skeleton className='h-4 w-1/2' />
                </div>
              ))}
            </div>
          </div>
        ) : displayed.length === 0 ? (
          <p className='p-6 text-sm text-muted-foreground'>
            {t('quality.tickets.empty')}
          </p>
        ) : (
          <ul className='divide-y divide-border'>
            {displayed.map((ticket) => (
              <TicketRow
                key={ticket.id}
                ticket={ticket}
                locale={locale}
                onOpenDetail={() => setDetailId(ticket.id)}
                onChanged={() => {
                  refreshFiltered();
                  onChanged();
                }}
              />
            ))}
          </ul>
        )}
      </CardContent>
      {detailId !== undefined ? (
        <TicketDetailDialog
          ticketId={detailId}
          client={client}
          onClose={() => setDetailId(undefined)}
          onChanged={() => {
            refreshFiltered();
            onChanged();
          }}
        />
      ) : null}
    </Card>
  );
}

/**
 * 一条工单。流转按钮只看服务端算好的 `canTransition`：没有「处理工单」的人
 * 看得到工单（要持有「查看」）但没有流转按钮（数组为空，连服务端都不给算）。
 * 转派在详情里发起；行上放验收点名的四个（受理、解决、关闭、重开）。
 */
function TicketRow({
  ticket,
  locale,
  onOpenDetail,
  onChanged,
}: {
  readonly ticket: QualityTicket;
  readonly locale: string;
  readonly onOpenDetail: () => void;
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new QualityClient(api), [api]);
  const [action, setAction] = useState<
    'accept' | 'resolve' | 'close' | 'reopen' | undefined
  >();
  const canTransition = transitionNames(ticket.canTransition);

  return (
    <li data-testid='ticket-row' className='flex flex-col gap-2 p-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <span className='font-mono text-xs text-muted-foreground'>
          {ticket.code}
        </span>
        <StatusBadge tone={severityTone(ticket.severity)} size='sm'>
          {t(`quality.severities.${ticket.severity}`, {
            defaultValue: ticket.severity,
          })}
        </StatusBadge>
        <StatusBadge tone='neutral' size='sm'>
          {ticket.category
            ? t(`quality.categories.${ticket.category}`, {
                defaultValue: ticket.category,
              })
            : t('quality.uncategorized')}
        </StatusBadge>
        <StatusBadge tone='info' size='sm'>
          {t(`quality.states.${ticket.state}`, {
            defaultValue: ticket.state,
          })}
        </StatusBadge>
        <span className='ml-auto text-xs text-muted-foreground'>
          {formatTime(ticket.createdAt, locale)}
        </span>
      </div>
      <p className='text-sm leading-6'>{ticket.title}</p>
      {ticket.description ? (
        <p className='text-sm leading-6'>{ticket.description}</p>
      ) : null}
      <div className='flex flex-wrap items-center gap-3 text-xs text-muted-foreground'>
        <span>
          {t('quality.tickets.department', {
            department: ticket.departmentTitle ?? t('quality.unassigned'),
          })}
        </span>
        <span>
          {t('quality.tickets.assignee', {
            name: ticket.assigneeName ?? t('quality.unassigned'),
          })}
        </span>
        <span className='ml-auto flex items-center gap-1'>
          {canTransition.includes('accept') ? (
            <Button
              variant='outline'
              size='sm'
              data-testid='row-transition-accept'
              onClick={() => setAction('accept')}
            >
              {t('quality.tickets.actions.accept')}
            </Button>
          ) : null}
          {canTransition.includes('resolve') ? (
            <Button
              variant='outline'
              size='sm'
              data-testid='row-transition-resolve'
              onClick={() => setAction('resolve')}
            >
              {t('quality.tickets.actions.resolve')}
            </Button>
          ) : null}
          {canTransition.includes('close') ? (
            <Button
              variant='outline'
              size='sm'
              data-testid='row-transition-close'
              onClick={() => setAction('close')}
            >
              {t('quality.tickets.actions.close')}
            </Button>
          ) : null}
          {canTransition.includes('reopen') ? (
            <Button
              variant='outline'
              size='sm'
              data-testid='row-transition-reopen'
              onClick={() => setAction('reopen')}
            >
              {t('quality.tickets.actions.reopen')}
            </Button>
          ) : null}
          <Button variant='ghost' size='sm' onClick={onOpenDetail}>
            <Search data-icon='inline-start' />
            {t('quality.tickets.detail')}
          </Button>
        </span>
      </div>
      {action === 'accept' ? (
        <RowTransitionDialog
          kind={action}
          ticket={ticket}
          client={client}
          onClose={() => setAction(undefined)}
          onChanged={onChanged}
        />
      ) : null}
      {action === 'resolve' ? (
        <RowTransitionDialog
          kind={action}
          ticket={ticket}
          client={client}
          onClose={() => setAction(undefined)}
          onChanged={onChanged}
        />
      ) : null}
      {action === 'close' ? (
        <RowTransitionDialog
          kind={action}
          ticket={ticket}
          client={client}
          onClose={() => setAction(undefined)}
          onChanged={onChanged}
        />
      ) : null}
      {action === 'reopen' ? (
        <RowTransitionDialog
          kind={action}
          ticket={ticket}
          client={client}
          onClose={() => setAction(undefined)}
          onChanged={onChanged}
        />
      ) : null}
    </li>
  );
}

/** 行上发起的流转复用详情里的对话框；成功之后刷列表（与统计）。 */
function RowTransitionDialog({
  kind,
  ticket,
  client,
  onClose,
  onChanged,
}: {
  readonly kind: 'accept' | 'resolve' | 'close' | 'reopen';
  readonly ticket: QualityTicket;
  readonly client: QualityClient;
  readonly onClose: () => void;
  readonly onChanged: () => void;
}): ReactElement {
  if (kind === 'accept') {
    return (
      <AcceptDialog
        ticket={ticket}
        client={client}
        onClose={onClose}
        onDone={onChanged}
      />
    );
  }
  if (kind === 'resolve') {
    return (
      <ResolveDialog
        ticket={ticket}
        client={client}
        onClose={onClose}
        onDone={onChanged}
      />
    );
  }
  if (kind === 'close') {
    return (
      <CloseDialog
        ticket={ticket}
        client={client}
        onClose={onClose}
        onDone={onChanged}
      />
    );
  }
  return (
    <ReopenDialog
      ticket={ticket}
      client={client}
      onClose={onClose}
      onDone={onChanged}
    />
  );
}
