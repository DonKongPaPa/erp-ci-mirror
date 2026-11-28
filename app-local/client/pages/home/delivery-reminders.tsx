import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useEffect, useState, type ReactElement } from 'react';
import { Link } from 'react-router';

import { errorText } from '#components/erp/messages';
import { Button } from '#components/ui/button';

import type { ReminderRow } from '../order-ledger/model.js';

const DAYS = [7, 14, 30] as const;

/**
 * R-064 首页「订单交付提醒」：只读窄端点，默认 7 天、块内可改 7/14/30。
 * 只有持 salesOrders.ledgerView 的会话看得到；超期与基准日全由服务端算，这里不比日期。
 */
export function DeliveryReminders(): ReactElement | null {
  const { t } = useTranslation();
  const api = useApiClient();
  const access = useCan({
    resource: { type: 'composite', id: 'salesOrders' },
    action: 'ledgerView',
  });
  const [days, setDays] = useState<number>(7);
  const [scope, setScope] = useState<'overdue' | 'upcoming'>('overdue');
  const [result, setResult] = useState<{
    readonly key: string;
    readonly items: readonly ReminderRow[];
    readonly error?: unknown;
  }>({ key: '', items: [] });

  const key = `${scope}:${days}`;
  useEffect(() => {
    if (!access.can || access.isPending) return;
    const controller = new AbortController();
    void api
      .request<{ items: readonly ReminderRow[]; total: number }>({
        path: `home/delivery-reminders?scope=${scope}&days=${days}`,
        signal: controller.signal,
      })
      .then((page) => {
        if (!controller.signal.aborted) {
          setResult({ key, items: page.items });
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setResult({ key, items: [], error: cause });
      });
    return () => controller.abort();
  }, [api, access.can, access.isPending, days, scope, key]);

  const current = result.key === key;
  const items = current ? result.items : [];
  const error = current ? result.error : undefined;
  const loading = current === false;

  // 权限还没落定或没有授权时什么都不画：不把端点返回的 403 暴露成一块空清单。
  if (access.isPending || !access.can) return null;

  return (
    <section
      data-testid='home-delivery-reminders'
      aria-labelledby='home-delivery-reminders-title'
      className='flex flex-col gap-3 rounded-2xl border border-border bg-card p-5'
    >
      <div className='flex flex-wrap items-end justify-between gap-3'>
        <h2 id='home-delivery-reminders-title' className='text-base font-medium'>
          {t('homeDelivery.title')}
        </h2>
        <div className='flex flex-wrap items-center gap-2'>
          <div className='flex items-center gap-1'>
            <Button
              size='sm'
              variant={scope === 'overdue' ? 'default' : 'outline'}
              aria-pressed={scope === 'overdue'}
              onClick={() => setScope('overdue')}
            >
              {t('homeDelivery.scopeOverdue')}
            </Button>
            <Button
              size='sm'
              variant={scope === 'upcoming' ? 'default' : 'outline'}
              aria-pressed={scope === 'upcoming'}
              onClick={() => setScope('upcoming')}
            >
              {t('homeDelivery.scopeUpcoming')}
            </Button>
          </div>
          <div className='flex items-center gap-1' aria-label={t('homeDelivery.days')}>
            {DAYS.map((value) => (
              <Button
                key={value}
                size='sm'
                variant={days === value ? 'default' : 'outline'}
                aria-pressed={days === value}
                onClick={() => setDays(value)}
              >
                {value}
              </Button>
            ))}
          </div>
        </div>
      </div>
      {error !== undefined ? (
        <p role='alert' className='text-sm text-destructive'>
          {errorText(error, t)}
        </p>
      ) : null}
      <ul data-testid='home-delivery-reminders-list' className='flex flex-col divide-y divide-border'>
        {loading ? <li role='status'>{t('status.loading')}</li> : null}
        {!loading && items.length === 0 ? (
          <li className='text-sm text-muted-foreground'>
            {t('homeDelivery.empty')}
          </li>
        ) : null}
        {items.map((row) => (
          <li key={`${row.salesOrderId}-${row.scope}`} className='py-2'>
            <Link
              to={`/sales-orders/${encodeURIComponent(row.salesOrderId)}`}
              aria-label={`${t('homeDelivery.open')} ${row.orderNo}`}
              className='flex flex-wrap items-center gap-2 text-sm hover:underline'
            >
              <span className='font-medium'>{row.orderNo}</span>
              <span className='text-muted-foreground'>
                {row.customer?.name ?? ''}
              </span>
              <span className='tabular-nums'>{row.baselineDate}</span>
              <span className={row.overdueDays > 0 ? 'text-destructive' : undefined}>
                {/* 服务端 days = 今天 - 基准日：负数是还有几天，0 是今天，正数才是超期。 */}
                {row.overdueDays < 0
                  ? t('homeDelivery.dueInDays', { days: -row.overdueDays })
                  : row.overdueDays === 0
                    ? t('homeDelivery.dueToday')
                    : t('homeDelivery.overdueDays', { days: row.overdueDays })}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
