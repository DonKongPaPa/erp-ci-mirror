/* eslint-disable react-refresh/only-export-components -- 这个文件给审批注册表提供一个渲染函数，只读视图的组件与它放在一起 */
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import type { ColumnDef } from '@tanstack/react-table';
import { type ReactElement } from 'react';
import { Link } from 'react-router';

import { LinesTable } from '#components/erp/document';
import { Button } from '#components/ui/button';

import { formatAmount, formatNumber } from '../orders/model.js';
import type { ApprovalDetail } from '../approvals/client.js';
import { Dash } from './fields.js';

/** 审批快照里的窄列：服务端只给这些键，页面不推断价格、人员或附件地址。 */
interface SnapshotLine {
  readonly id: string;
  readonly itemId: string;
  readonly qty: number;
  readonly expectedPrice: number | null;
  readonly expectedAmount: number | null;
  readonly item: {
    readonly code: string;
    readonly name: string;
    readonly spec: string | null;
    readonly unitCode: string;
  };
}

interface RequestSnapshot {
  readonly docNo?: unknown;
  readonly requestDate?: unknown;
  readonly department?: unknown;
  readonly requester?: unknown;
  readonly projectLabel?: unknown;
  readonly projectCode?: unknown;
  readonly customText1?: unknown;
  readonly customText2?: unknown;
  readonly description?: unknown;
  readonly totalQty?: unknown;
  readonly estimatedTotal?: unknown;
  readonly lines?: unknown;
}

const text = (value: unknown): string =>
  value === null || value === undefined || value === ''
    ? ''
    : typeof value === 'string' || typeof value === 'number'
      ? String(value)
      : '';

const num = (value: unknown): number | null =>
  typeof value === 'number' ? value : null;

function Field({
  label,
  value,
}: {
  readonly label: string;
  readonly value: ReactElement | string;
}): ReactElement {
  return (
    <div className='contents'>
      <dt className='font-medium text-muted-foreground'>{label}</dt>
      <dd className='break-words'>{value || <Dash />}</dd>
    </div>
  );
}

/** 审批详情里的请购单页签：表头与明细的只读视图，加一条打开原单的链接。 */
export function renderPurchaseRequestApprovalTab(detail: ApprovalDetail): ReactElement {
  return <PurchaseRequestApprovalContent detail={detail} />;
}

function PurchaseRequestApprovalContent({
  detail,
}: {
  readonly detail: ApprovalDetail;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const round =
    detail.rounds.find((item) => item.round === detail.currentRound) ??
    detail.rounds.at(-1);
  const snap = (round?.snapshot ?? {}) as RequestSnapshot;
  const department = snap.department as { name?: unknown } | undefined;
  const requester = snap.requester as { name?: unknown } | undefined;
  const lines = Array.isArray(snap.lines) ? (snap.lines as SnapshotLine[]) : [];
  const columns: ColumnDef<SnapshotLine>[] = [
    {
      id: 'item',
      header: t('purchaseRequests.fields.item'),
      cell: ({ row }) => (
        <span className='flex min-w-0 flex-col'>
          <span className='font-medium tabular-nums'>{row.original.item.code}</span>
          <span className='wrap-anywhere'>{row.original.item.name}</span>
        </span>
      ),
    },
    {
      id: 'qty',
      header: t('purchaseRequests.fields.qty'),
      cell: ({ row }) => formatNumber(row.original.qty, locale),
    },
    {
      id: 'expectedPrice',
      header: t('purchaseRequests.fields.expectedPrice'),
      cell: ({ row }) =>
        row.original.expectedPrice === null
          ? <Dash />
          : formatAmount(row.original.expectedPrice, locale),
    },
    {
      id: 'expectedAmount',
      header: t('purchaseRequests.fields.expectedAmount'),
      cell: ({ row }) =>
        row.original.expectedAmount === null
          ? <Dash />
          : formatAmount(row.original.expectedAmount, locale),
    },
  ];

  return (
    <div data-testid='approval-purchase-request' className='flex flex-col gap-4 text-sm'>
      <div>
        <Button
          variant='outline'
          size='sm'
          nativeButton={false}
          render={<Link to={`/purchase-requests/${detail.dataKey}`} />}
        >
          {t('purchaseRequests.actions.openRequest')}
        </Button>
      </div>
      <dl className='grid grid-cols-2 gap-x-4 gap-y-2'>
        <Field label={t('purchaseRequests.fields.docNo')} value={text(snap.docNo)} />
        <Field label={t('purchaseRequests.fields.requestDate')} value={text(snap.requestDate)} />
        <Field label={t('purchaseRequests.fields.department')} value={text(department?.name)} />
        <Field label={t('purchaseRequests.fields.requester')} value={text(requester?.name)} />
        <Field
          label={t('purchaseRequests.fields.project')}
          value={text(snap.projectLabel) || text(snap.projectCode)}
        />
        <Field label={t('purchaseRequests.fields.customText1')} value={text(snap.customText1)} />
        <Field label={t('purchaseRequests.fields.customText2')} value={text(snap.customText2)} />
        <Field label={t('purchaseRequests.fields.description')} value={text(snap.description)} />
        <Field
          label={t('purchaseRequests.fields.totalQty')}
          value={num(snap.totalQty) === null ? '' : formatNumber(num(snap.totalQty)!, locale)}
        />
        <Field
          label={t('purchaseRequests.fields.estimatedTotal')}
          value={
            num(snap.estimatedTotal) === null
              ? ''
              : formatAmount(num(snap.estimatedTotal)!, locale)
          }
        />
      </dl>
      <div className='flex min-w-0 flex-col gap-2'>
        <h4 className='font-medium'>{t('purchaseRequests.fields.lines')}</h4>
        <LinesTable<SnapshotLine>
          columns={columns}
          rows={lines}
          getRowId={(line) => line.id}
          emptyMessage={t('purchaseRequests.form.linesEmpty')}
        />
      </div>
    </div>
  );
}
