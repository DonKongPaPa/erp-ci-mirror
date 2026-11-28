import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { FeedbackForm } from '#components/feedback-form';
import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '#components/ui/dialog';
import { Input } from '#components/ui/input';

import { ReconciliationClient, type ReceivableOrder, type ReconOption, type SourceDoc } from './client.js';
import type { ReconKind } from './kinds.js';
import { SALES_ORDERS_RESOURCE } from '../sales-orders/page-id.js';

/**
 * 建对账单时勾选已过账的单据。选中多个后一次加入草稿，金额仍由服务按快照摊开。
 * 端点走财务自己的窄读动作，没有明细、单价、经办人。
 */
export function SourceDocPicker({
  kind, open, onOpenChange, selected, onPick,
}: {
  readonly kind: ReconKind;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly selected: readonly string[];
  readonly onPick: (ids: readonly string[]) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new ReconciliationClient(api), [api]);
  const view = useCan({ resource: kind.resource, action: 'view' });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly SourceDoc[]>([]);
  const [checked, setChecked] = useState<readonly string[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !view.can) return;
    const controller = new AbortController();
    client.sourceDocs(kind.sourceKind, { q: query, pageSize: 100 })
      .then((page) => {
        if (!controller.signal.aborted) {
          setError(undefined);
          setRows(page.items);
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setRows([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => controller.abort();
  }, [open, view.can, client, kind.sourceKind, query]);

  // 打开时按草稿已有的勾选初始化；不用 effect 同步 props，避免级联渲染。
  const changeOpen = (next: boolean): void => {
    if (next) setChecked(selected);
    onOpenChange(next);
  };

  const title = t(kind.sourceKind === 'out'
    ? 'reconciliation.pickOutbound' : 'reconciliation.pickInbound');
  const toggle = (id: string) => {
    setChecked((old) => old.includes(id) ? old.filter((one) => one !== id) : [...old, id]);
  };

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogContent className='max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{t('reconciliation.pickSourceHint')}</DialogDescription>
        </DialogHeader>
        <FeedbackForm
          className='flex gap-2'
          onSubmit={(event) => { event.preventDefault(); setQuery(q.trim()); }}
        >
          <Input
            aria-label={t('reconciliation.pickSourceSearch')}
            placeholder={t('reconciliation.pickSourceSearch')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button type='submit' variant='outline'>{t('erp.list.filters')}</Button>
        </FeedbackForm>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {!view.can ? (
          <p role='status' className='text-sm text-muted-foreground'>{t('erp.errors.denied')}</p>
        ) : (
          <>
            <ul className='divide-y'>
              {rows.map((row) => (
                <li key={row.id} className='flex items-center gap-3 py-2'>
                  <Checkbox
                    checked={checked.includes(row.id)}
                    onCheckedChange={() => toggle(row.id)}
                    aria-label={t('reconciliation.pickSourceDoc', { docNo: row.docNo })}
                  />
                  <span className='font-medium tabular-nums'>{row.docNo}</span>
                  <span className='text-sm text-muted-foreground'>{row.docDate ?? ''}</span>
                  <span className='text-sm text-muted-foreground'>{row.partnerName ?? ''}</span>
                </li>
              ))}
            </ul>
            <Button
              type='button'
              onClick={() => { onPick(checked); changeOpen(false); }}
            >
              {t('reconciliation.addSelected')}
            </Button>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 收入/开票绑销售订单：只读八列头与客户摘要。 */
export function ReceivableOrderPicker({
  open, onOpenChange, onPick,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (order: ReceivableOrder) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new ReconciliationClient(api), [api]);
  const view = useCan({ resource: SALES_ORDERS_RESOURCE, action: 'financeView' });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly ReceivableOrder[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !view.can) return;
    const controller = new AbortController();
    client.receivableOrders({ q: query, pageSize: 100 })
      .then((page) => {
        if (!controller.signal.aborted) { setError(undefined); setRows(page.items); }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setRows([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => controller.abort();
  }, [open, view.can, client, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{t('reconciliation.pickSalesOrder')}</DialogTitle>
          <DialogDescription>{t('reconciliation.pickOrderHint')}</DialogDescription>
        </DialogHeader>
        <FeedbackForm
          className='flex gap-2'
          onSubmit={(event) => { event.preventDefault(); setQuery(q.trim()); }}
        >
          <Input
            aria-label={t('reconciliation.pickOrderSearch')}
            placeholder={t('reconciliation.pickOrderSearch')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button type='submit' variant='outline'>{t('erp.list.filters')}</Button>
        </FeedbackForm>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {!view.can ? (
          <p role='status' className='text-sm text-muted-foreground'>{t('erp.errors.denied')}</p>
        ) : (
          <ul className='divide-y'>
            {rows.map((row) => (
              <li key={row.id} className='flex items-center gap-3 py-2'>
                <span className='font-medium tabular-nums'>{row.orderNo}</span>
                <span className='text-sm text-muted-foreground'>{row.customer?.name ?? ''}</span>
                <Button
                  size='sm' variant='outline' className='ml-auto'
                  aria-label={t('reconciliation.pickOrder', { orderNo: row.orderNo })}
                  onClick={() => { onPick(row); onOpenChange(false); }}
                >
                  {t('reconciliation.pick')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}

/** 收入/开票绑对账单：只列已确认的，两列核销金额照服务端给的原样显示。 */
export function ReconPicker({
  apiBase, resourceId, open, onOpenChange, onPick,
}: {
  readonly apiBase: string;
  readonly resourceId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onPick: (option: ReconOption) => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new ReconciliationClient(api), [api]);
  const view = useCan({ resource: { type: 'composite', id: resourceId }, action: 'view' });
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [rows, setRows] = useState<readonly ReconOption[]>([]);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (!open || !view.can) return;
    const controller = new AbortController();
    client.reconOptions(apiBase, { q: query, pageSize: 100 })
      .then((page) => {
        if (!controller.signal.aborted) { setError(undefined); setRows(page.items); }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setRows([]);
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      });
    return () => controller.abort();
  }, [open, view.can, client, apiBase, query]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className='max-w-3xl'>
        <DialogHeader>
          <DialogTitle>{t('reconciliation.pickRecon')}</DialogTitle>
          <DialogDescription>{t('reconciliation.pickReconHint')}</DialogDescription>
        </DialogHeader>
        <FeedbackForm
          className='flex gap-2'
          onSubmit={(event) => { event.preventDefault(); setQuery(q.trim()); }}
        >
          <Input
            aria-label={t('reconciliation.pickReconSearch')}
            placeholder={t('reconciliation.pickReconSearch')}
            value={q}
            onChange={(event) => setQ(event.target.value)}
          />
          <Button type='submit' variant='outline'>{t('erp.list.filters')}</Button>
        </FeedbackForm>
        {error ? <p role='alert' className='text-sm text-destructive'>{error}</p> : null}
        {!view.can ? (
          <p role='status' className='text-sm text-muted-foreground'>{t('erp.errors.denied')}</p>
        ) : (
          <ul className='divide-y'>
            {rows.map((row) => (
              <li key={row.id} className='flex items-center gap-3 py-2'>
                <span className='font-medium tabular-nums'>{row.docNo}</span>
                <span className='text-sm text-muted-foreground'>{row.reconDate}</span>
                <span className='text-sm tabular-nums'>
                  {t('reconciliation.reconciledIncomeAmount')} {row.reconciledIncomeAmount ?? 0}
                </span>
                <span className='text-sm tabular-nums'>
                  {t('reconciliation.reconciledInvoiceAmount')} {row.reconciledInvoiceAmount ?? 0}
                </span>
                <Button
                  size='sm' variant='outline' className='ml-auto'
                  aria-label={t('reconciliation.pickReconDoc', { docNo: row.docNo })}
                  onClick={() => { onPick(row); onOpenChange(false); }}
                >
                  {t('reconciliation.pick')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
