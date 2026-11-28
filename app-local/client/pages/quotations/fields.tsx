import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useId, useState, type ReactElement } from 'react';

import { StatusBadge } from '#components/status-badge';
import { Input } from '#components/ui/input';
import {
  Field,
  FieldError,
  FieldLabel,
} from '#components/ui/field';

import type { Quotation, QuotationStatus } from './client.js';
import { formatAmount, formatNumber, parseDate } from './model.js';

/** 共用的短横线：服务端还没算出来就是「—」，不当成 0。 */
export function Dash(): ReactElement {
  return <span className='text-muted-foreground'>—</span>;
}

const TONES = {
  draft: 'neutral',
  confirmed: 'info',
  converted: 'success',
  void: 'neutral',
} as const;

export function QuotationStatusBadge({
  status,
}: {
  readonly status: QuotationStatus;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={TONES[status] ?? 'neutral'}>
      {t(`quotations.status.${status}`)}
    </StatusBadge>
  );
}

/** 有效期过了不拦业务，只在列表与详情标出来（标记由服务端算）。 */
export function ExpiredBadge(): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone='warning'>
      {t('quotations.expired')}
    </StatusBadge>
  );
}

/** 六个只读合计：全部来自服务端响应，页面一个都不算。 */
export function QuotationTotals({
  quotation,
}: {
  readonly quotation: Quotation | null;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const number = (value: number | null | undefined): ReactElement =>
    value === null || value === undefined ? (
      <Dash />
    ) : (
      <span className='tabular-nums'>{formatNumber(value, locale)}</span>
    );
  const money = (value: number | null | undefined): ReactElement =>
    value === null || value === undefined ? (
      <Dash />
    ) : (
      <span className='tabular-nums'>
        {t('quotations.money', { amount: formatAmount(value, locale) })}
      </span>
    );
  const rows = [
    ['totalQty', t('quotations.fields.totalQty'), number(quotation?.totalQty)],
    ['taxIncludedTotal', t('quotations.fields.taxIncludedTotal'), money(quotation?.taxIncludedTotal)],
    ['taxExcludedTotal', t('quotations.fields.taxExcludedTotal'), money(quotation?.taxExcludedTotal)],
    ['taxTotal', t('quotations.fields.taxTotal'), money(quotation?.taxTotal)],
    ['discountAmount', t('quotations.fields.discountAmount'), money(quotation?.discountAmount)],
    ['payableTotal', t('quotations.fields.payableTotal'), money(quotation?.payableTotal)],
  ] as const;
  return (
    <dl className='grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-3'>
      {rows.map(([key, label, value]) => (
        <div key={key} className='flex min-w-0 flex-col gap-1'>
          <dt className='text-muted-foreground'>{label}</dt>
          <dd data-testid={`quotation-${key.replace(/([A-Z])/gu, '-$1').toLowerCase()}`}>
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * 有效期筛选填的是「年-月-日」（端点的 `validFrom` / `validTo` 收的就是日子，不是 ISO 时间串）：
 * 回车或离开输入框才生效，写得不合规标在下面、不发请求。
 */
export function DayFilter({
  label,
  value,
  onChange,
}: {
  readonly label: string;
  readonly value: string;
  readonly onChange: (day: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState(value);
  const [invalid, setInvalid] = useState(false);
  const commit = (): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      setInvalid(false);
      if (value) onChange('');
      return;
    }
    if (!parseDate(trimmed)) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    if (trimmed !== value) onChange(trimmed);
  };
  return (
    <Field className='w-44' data-invalid={invalid ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        key={value}
        id={id}
        inputMode='numeric'
        autoComplete='off'
        placeholder={t('quotations.filters.datePlaceholder')}
        aria-invalid={invalid ? true : undefined}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setInvalid(false);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            commit();
          }
        }}
      />
      {invalid ? <FieldError>{t('quotations.errors.dateInvalid')}</FieldError> : null}
    </Field>
  );
}
