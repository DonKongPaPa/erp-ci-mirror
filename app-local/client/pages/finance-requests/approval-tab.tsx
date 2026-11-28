/* eslint-disable react-refresh/only-export-components -- 这个文件给审批注册表提供一个渲染函数，只读视图的组件与它放在一起 */
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { type ReactElement } from 'react';
import { Link } from 'react-router';

import { Button } from '#components/ui/button';

import { formatAmount } from '../orders/model.js';
import type { ApprovalDetail } from '../approvals/client.js';
import { Dash } from './fields.js';

/**
 * 审批快照里的窄列：服务端只给这些键，页面不推断人员电话、邮箱，也不回附件存储键。
 */
interface RequestSnapshot {
  readonly docNo?: unknown;
  readonly docType?: unknown;
  readonly requestDate?: unknown;
  readonly expenseTypeLabel?: unknown;
  readonly expenseTypeCode?: unknown;
  readonly amount?: unknown;
  readonly reason?: unknown;
  readonly handler?: unknown;
  readonly projectLabel?: unknown;
  readonly projectCode?: unknown;
  readonly files?: unknown;
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

/** 审批详情里的请款 / 报销页签：表头的只读视图，加一条打开原单的链接。 */
export function renderFinanceRequestApprovalTab(
  detail: ApprovalDetail,
): ReactElement {
  return <FinanceRequestApprovalContent detail={detail} />;
}

function FinanceRequestApprovalContent({
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
  const handler = snap.handler as { name?: unknown } | undefined;
  const docType =
    typeof snap.docType === 'string'
      ? t(`financeRequestDocs.docTypes.${snap.docType}`)
      : '';
  const files = Array.isArray(snap.files) ? snap.files.length : 0;
  const amount = num(snap.amount);

  return (
    <div data-testid='approval-finance-request' className='flex flex-col gap-4 text-sm'>
      <div>
        <Button
          variant='outline'
          size='sm'
          nativeButton={false}
          render={<Link to={`/finance-requests/${detail.dataKey}`} />}
        >
          {t('financeRequestDocs.actions.openRequest')}
        </Button>
      </div>
      <dl className='grid grid-cols-2 gap-x-4 gap-y-2'>
        <Field label={t('financeRequestDocs.fields.docNo')} value={text(snap.docNo)} />
        <Field label={t('financeRequestDocs.fields.docType')} value={docType} />
        <Field label={t('financeRequestDocs.fields.requestDate')} value={text(snap.requestDate)} />
        <Field
          label={t('financeRequestDocs.fields.expenseType')}
          value={text(snap.expenseTypeLabel) || text(snap.expenseTypeCode)}
        />
        <Field
          label={t('financeRequestDocs.fields.amount')}
          value={amount === null ? '' : formatAmount(amount, locale)}
        />
        <Field label={t('financeRequestDocs.fields.handler')} value={text(handler?.name)} />
        <Field
          label={t('financeRequestDocs.fields.project')}
          value={text(snap.projectLabel) || text(snap.projectCode)}
        />
        <Field label={t('financeRequestDocs.fields.reason')} value={text(snap.reason)} />
        <Field label={t('erp.docFiles.files')} value={String(files)} />
      </dl>
    </div>
  );
}
