import { resolveListState, useApiClient } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { ChevronDown } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { DataTable } from '#components/data-table';
import { RowActions } from '#components/row-actions';
import { redactRecipientAddresses } from '#lib/redact-recipients';
import { SettingsModulePage } from './settings-module-page.js';
import { SettingsError } from './shared.js';
import { StatusBadge } from '#components/status-badge';
import { Button } from '#components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import type { ColumnDef } from '@tanstack/react-table';

/**
 * R-034「通知记录」：只读地看通知发出去了没、哪一步失败的。
 *
 * 数据只来自插件现成的两个只读接口：`GET /api/notifications/logs`（游标分页）与
 * `GET /api/notifications/logs/:logId`。没有发送、重发、删除的入口。
 *
 * 收件人与消息内容不显示：插件的公开接口按设计删掉了这两个字段，要查「谁没收到」
 * 用记录上的业务类型与业务单据号回到业务记录去看。这一页也不扩大接口。
 */

interface NotificationError {
  code?: string;
  message: string;
  category?: string;
}

interface Delivery {
  id: string;
  notificationId: string;
  channelName: string;
  channelType: string;
  providerType: string;
  attemptCount: number;
  status: string;
  nextRunAt?: string;
  lastError?: NotificationError;
  retryResolution?: { type: string; reason: string; requestedAt: string };
  createdAt: string;
  updatedAt: string;
}

interface Attempt {
  id: string;
  deliveryId: string;
  sequence: number;
  providerType: string;
  status: string;
  startedAt: string;
  finishedAt?: string;
  error?: NotificationError;
}

interface RetryAudit {
  id: string;
  deliveryId: string;
  resolution: { type: string; reason: string; requestedAt: string };
  createdAt: string;
}

interface LogEntry {
  log: {
    id: string;
    idempotencyKey?: string;
    sourceType: string;
    sourceReferenceId?: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  };
  deliveries: {
    delivery: Delivery;
    attempts: Attempt[];
    retryAudits: RetryAudit[];
  }[];
}

const logTone: Record<string, 'neutral' | 'info' | 'warning' | 'success'> = {
  pending: 'info',
  processing: 'info',
  completed: 'success',
  partial: 'warning',
  failed: 'warning',
  unknown: 'neutral',
};

const deliveryTone: Record<string, 'neutral' | 'info' | 'warning' | 'success'> =
  {
    pending: 'info',
    preparing: 'info',
    submitting: 'info',
    retrying: 'warning',
    accepted: 'success',
    failed: 'warning',
    unknown: 'neutral',
  };

function formatTime(value: string | undefined, language: string) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(date);
}

export default function NotificationLogsPage(): ReactElement {
  const { t, i18n } = useTranslation();
  const api = useApiClient();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [nextToken, setNextToken] = useState<string>();
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>();
  const [detailId, setDetailId] = useState<string>();
  const [detail, setDetail] = useState<LogEntry>();
  const [detailError, setDetailError] = useState<unknown>();
  const [detailLoading, setDetailLoading] = useState(false);

  // 第一页：和 `use-list-data` 同一个写法 —— 请求的 then 回调里改状态，
  // effect 体内不同步 setState。重试只递增 revision，让 effect 再读一次。
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    void api
      .request<{
        data: LogEntry[];
        meta: { nextPageToken?: string };
      }>({ path: 'notifications/logs', signal: controller.signal })
      .then(
        (page) => {
          if (controller.signal.aborted) return;
          setEntries(page.data);
          setNextToken(page.meta.nextPageToken);
          setError(undefined);
          setLoading(false);
        },
        (next: unknown) => {
          if (controller.signal.aborted) return;
          setError(next);
          setLoading(false);
        },
      );
    return () => controller.abort();
  }, [api, revision]);

  const retry = () => {
    setError(undefined);
    setLoading(true);
    setRevision((value) => value + 1);
  };

  // 游标分页：点「加载更多」把下一页接到后面。
  const loadMore = async () => {
    if (!nextToken) return;
    setLoadingMore(true);
    setError(undefined);
    try {
      const page = await api.request<{
        data: LogEntry[];
        meta: { nextPageToken?: string };
      }>({
        path: 'notifications/logs',
        query: { pageToken: nextToken },
      });
      setEntries((current) => [...current, ...page.data]);
      setNextToken(page.meta.nextPageToken);
    } catch (next) {
      setError(next);
    } finally {
      setLoadingMore(false);
    }
  };

  const openDetail = useCallback(
    async (id: string) => {
      setDetailId(id);
      setDetail(undefined);
      setDetailError(undefined);
      setDetailLoading(true);
      try {
        const response = await api.request<{ data: LogEntry }>({
          path: `notifications/logs/${encodeURIComponent(id)}`,
        });
        setDetail(response.data);
      } catch (next) {
        setDetailError(next);
      } finally {
        setDetailLoading(false);
      }
    },
    [api],
  );

  const listState = resolveListState(
    {
      data: error ? undefined : entries,
      error,
      isPending: loading && entries.length === 0,
    },
    entries.length,
    false,
  );

  const columns = useMemo<ColumnDef<LogEntry>[]>(
    () => [
      {
        id: 'createdAt',
        header: t('notificationLogs.sentAt'),
        enableSorting: false,
        cell: ({ row }) =>
          formatTime(row.original.log.createdAt, i18n.language),
      },
      {
        id: 'source',
        header: t('notificationLogs.source'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className='block max-w-64 truncate'>
            {row.original.log.sourceReferenceId
              ? `${row.original.log.sourceType} · ${row.original.log.sourceReferenceId}`
              : row.original.log.sourceType}
          </span>
        ),
      },
      {
        id: 'status',
        header: t('notificationLogs.status'),
        enableSorting: false,
        cell: ({ row }) => (
          <StatusBadge tone={logTone[row.original.log.status] ?? 'neutral'}>
            {t(`notificationLogs.statusLabel.${row.original.log.status}`, {
              defaultValue: row.original.log.status,
            })}
          </StatusBadge>
        ),
      },
      {
        id: 'deliveries',
        header: t('notificationLogs.deliveries'),
        enableSorting: false,
        cell: ({ row }) => (
          <span className='block max-w-64 truncate text-muted-foreground'>
            {deliverySummary(
              row.original,
              i18n.language,
              t('notificationLogs.noDeliveries'),
              (name, count) =>
                t('notificationLogs.deliveryCount', { name, count }),
            )}
          </span>
        ),
      },
      {
        id: 'actions',
        header: () => (
          <span className='sr-only'>{t('notificationLogs.actions')}</span>
        ),
        enableSorting: false,
        cell: ({ row }) => (
          <RowActions
            label={t('notificationLogs.actionsFor', {
              source: row.original.log.sourceType,
            })}
            actions={[
              {
                key: 'detail',
                label: t('notificationLogs.open'),
                onClick: () => void openDetail(row.original.log.id),
              },
            ]}
          />
        ),
      },
    ],
    [t, i18n.language, openDetail],
  );

  return (
    <SettingsModulePage title={t('notificationLogs.title')}>
      <p className='text-sm text-muted-foreground'>
        {t('notificationLogs.description')}
      </p>
      <SettingsError error={error} retry={retry} />
      <DataTable<LogEntry>
        columns={columns}
        data={entries}
        getRowId={(row) => row.log.id}
        pagination={false}
        listState={listState}
        onRetry={retry}
        loading={loading && entries.length > 0}
        emptyMessage={t('notificationLogs.empty')}
      />
      {nextToken ? (
        <div>
          <Button
            variant='outline'
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            <ChevronDown />
            {loadingMore
              ? t('notificationLogs.loading')
              : t('notificationLogs.loadMore')}
          </Button>
        </div>
      ) : null}
      <Dialog
        open={Boolean(detailId)}
        onOpenChange={(open) => {
          if (!open) {
            setDetailId(undefined);
            setDetail(undefined);
            setDetailError(undefined);
          }
        }}
      >
        <DialogContent className='sm:max-w-2xl'>
          <DialogHeader>
            <DialogTitle>{t('notificationLogs.detailTitle')}</DialogTitle>
            <DialogDescription>
              {t('notificationLogs.detailDescription')}
            </DialogDescription>
          </DialogHeader>
          {detailLoading ? (
            <p role='status' className='text-sm text-muted-foreground'>
              {t('notificationLogs.loading')}
            </p>
          ) : null}
          <SettingsError
            error={detailError}
            retry={detailId ? () => void openDetail(detailId) : undefined}
            inline
          />
          {detail ? <LogDetail entry={detail} /> : null}
        </DialogContent>
      </Dialog>
    </SettingsModulePage>
  );
}

/** 各渠道各几条，例如 `inbox × 2、email × 1`。 */
function deliverySummary(
  entry: LogEntry,
  language: string,
  empty: string,
  label: (name: string, count: number) => string,
): string {
  if (entry.deliveries.length === 0) return empty;
  const counts = new Map<string, number>();
  for (const item of entry.deliveries) {
    counts.set(
      item.delivery.channelName,
      (counts.get(item.delivery.channelName) ?? 0) + 1,
    );
  }
  const parts = [...counts].map(([name, count]) => label(name, count));
  return new Intl.ListFormat(language, { style: 'short', type: 'unit' }).format(
    parts,
  );
}

function LogDetail({ entry }: { readonly entry: LogEntry }): ReactElement {
  const { t, i18n } = useTranslation();
  return (
    <div className='flex flex-col gap-4'>
      <dl className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'>
        <dt className='text-muted-foreground'>
          {t('notificationLogs.source')}
        </dt>
        <dd>
          {entry.log.sourceReferenceId
            ? `${entry.log.sourceType} · ${entry.log.sourceReferenceId}`
            : entry.log.sourceType}
        </dd>
        <dt className='text-muted-foreground'>
          {t('notificationLogs.status')}
        </dt>
        <dd>
          {t(`notificationLogs.statusLabel.${entry.log.status}`, {
            defaultValue: entry.log.status,
          })}
        </dd>
        <dt className='text-muted-foreground'>
          {t('notificationLogs.updatedAt')}
        </dt>
        <dd>{formatTime(entry.log.updatedAt, i18n.language)}</dd>
      </dl>
      {entry.deliveries.length === 0 ? (
        <p className='text-sm text-muted-foreground'>
          {t('notificationLogs.noDeliveries')}
        </p>
      ) : (
        <ul className='flex flex-col gap-3'>
          {entry.deliveries.map(({ delivery, attempts }) => (
            <li
              key={delivery.id}
              className='rounded-lg border border-border p-3 text-sm'
            >
              <div className='flex flex-wrap items-center gap-2'>
                <span className='font-medium'>{delivery.channelName}</span>
                <span className='text-muted-foreground'>
                  {delivery.channelType} · {delivery.providerType}
                </span>
                <StatusBadge tone={deliveryTone[delivery.status] ?? 'neutral'}>
                  {t(`notificationLogs.deliveryStatus.${delivery.status}`, {
                    defaultValue: delivery.status,
                  })}
                </StatusBadge>
              </div>
              <p className='mt-1 text-muted-foreground'>
                {t('notificationLogs.attempts', {
                  count: delivery.attemptCount,
                })}
                {delivery.nextRunAt
                  ? ` · ${t('notificationLogs.nextRunAt', {
                      time: formatTime(delivery.nextRunAt, i18n.language),
                    })}`
                  : ''}
              </p>
              {delivery.lastError ? (
                <p className='mt-1 text-destructive'>
                  {t('notificationLogs.lastError', {
                    category: delivery.lastError.category ?? '—',
                    message: redactRecipientAddresses(
                      delivery.lastError.message,
                    ),
                  })}
                </p>
              ) : null}
              {attempts.length > 0 ? (
                <ol className='mt-2 flex flex-col gap-1 text-muted-foreground'>
                  {attempts.map((attempt) => (
                    <li key={attempt.id}>
                      {t('notificationLogs.attemptLine', {
                        sequence: attempt.sequence,
                        status: attempt.status,
                        time: formatTime(attempt.startedAt, i18n.language),
                      })}
                      {attempt.error
                        ? ` · ${t('notificationLogs.attemptError', {
                            category: attempt.error.category ?? '—',
                            message: redactRecipientAddresses(
                              attempt.error.message,
                            ),
                          })}`
                        : ''}
                    </li>
                  ))}
                </ol>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      <p className='text-xs text-muted-foreground'>
        {t('notificationLogs.readOnlyHint')}
      </p>
    </div>
  );
}
