import { useTranslation } from '@nocobase/i18n/client';
import { useId, useState, type ReactElement, type ReactNode } from 'react';

import { StatusBadge } from '#components/status-badge';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from '#components/ui/field';
import { Input } from '#components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

import type { OrderKindDef } from './kinds.js';
import { dateFromIso, dayEnd, dayStart, parseDate } from './model.js';
import type { Choice } from './reference.js';
import type { Order } from './client.js';
import type { Item } from './reference.js';

/**
 * 订单页面自己的一组字段构件。共用地基的 `FormField` 要放在 `FormDialog` 里才能用，
 * 单据的新建与编辑是盖在列表上的子页、明细是表格，所以这里照它的样子另写几个：
 * 标签在上面（表格里的时候只给读屏软件），错了标在控件下面。
 */

export function Dash(): ReactElement {
  return <span className='text-muted-foreground'>—</span>;
}

/** 状态徽标：草稿、已取消灰，进行中蓝，完成绿；没登记的状态照端点的值显示。 */
export function OrderStatusBadge({
  def,
  order,
}: {
  readonly def: OrderKindDef;
  readonly order: Pick<Order, 'status' | 'apiStatus'>;
}): ReactElement {
  const { t } = useTranslation();
  const entry = def.statuses.find((item) => item.value === order.status);
  return (
    <StatusBadge size='sm' tone={entry?.tone ?? 'neutral'}>
      {entry ? t(`${def.l}.status.${entry.value}`) : order.apiStatus}
    </StatusBadge>
  );
}

/** 明细里的物料：编码、名称、规格三行；档案还没读到时先画「—」。 */
export function ItemCell({
  item,
}: {
  readonly item: Item | undefined;
}): ReactElement {
  if (!item) return <Dash />;
  return (
    <span className='flex min-w-0 flex-col'>
      <span className='font-medium tabular-nums'>{item.code}</span>
      <span className='wrap-anywhere'>{item.name}</span>
      {item.spec ? (
        <span className='wrap-anywhere text-muted-foreground'>{item.spec}</span>
      ) : null}
    </span>
  );
}

/** 一个可填的字段：标签在上面，必填的加星号，错了在下面标出来。 */
export function PageField({
  id,
  label,
  required,
  error,
  hint,
  className,
  children,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly required?: boolean;
  readonly error?: string;
  readonly hint?: ReactNode;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Field className={className} data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden='true' className='text-destructive'>
            *
          </span>
        ) : null}
      </FieldLabel>
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** 表格里的一格控件：错了标在控件下面。 */
export function CellField({
  invalid,
  error,
  children,
}: {
  readonly invalid: boolean;
  readonly error?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Field
      className='min-w-0'
      data-invalid={invalid || error ? true : undefined}
    >
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/** 一个下拉选择。表格里用的时候 `hideLabel`：可见的标签是表头，读屏软件仍然听得到。 */
export function SelectField({
  id,
  label,
  hideLabel = false,
  required,
  error,
  hint,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  className,
}: {
  readonly id: string;
  readonly label: string;
  readonly hideLabel?: boolean;
  readonly required?: boolean;
  readonly error?: string;
  readonly hint?: ReactNode;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly Choice[];
  readonly placeholder: string;
  readonly disabled?: boolean;
  readonly className?: string;
}): ReactElement {
  const items = options.map(({ value: key, label: text }) => ({
    value: key,
    label: text,
  }));
  return (
    <Field className={className} data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id} className={hideLabel ? 'sr-only' : undefined}>
        {label}
        {required ? (
          <span aria-hidden='true' className='text-destructive'>
            *
          </span>
        ) : null}
      </FieldLabel>
      <Select
        items={items}
        value={value || null}
        onValueChange={(next) => onChange(next === null ? '' : String(next))}
        disabled={disabled}
      >
        <SelectTrigger
          id={id}
          className='w-full'
          aria-invalid={error ? true : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem
              key={option.value}
              value={option.value}
              disabled={option.disabled}
            >
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error ? <FieldError>{error}</FieldError> : null}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/**
 * 展开筛选里的一个日子：「年-月-日」填，回车或离开输入框时才生效；写得不合规就标在下面，不发请求。
 * 地址栏里记的是带时区的 ISO 时间串（端点 `from` / `to` 的写法）。地址栏的值被别处改了
 * （「清空筛选」、浏览器后退）就按新值重画一个输入框。
 */
export function DateFilter({
  label,
  value,
  end = false,
  onChange,
}: {
  readonly label: string;
  /** 地址栏里的值（ISO 时间串），空串就是没筛。 */
  readonly value: string;
  /** `to` 含端点，取这一天的最后一毫秒。 */
  readonly end?: boolean;
  readonly onChange: (iso: string) => void;
}): ReactElement {
  return (
    <DateInput
      key={`${value}|${end}`}
      label={label}
      initial={dateFromIso(value) ?? ''}
      value={value}
      end={end}
      onChange={onChange}
    />
  );
}

function DateInput({
  label,
  initial,
  value,
  end,
  onChange,
}: {
  readonly label: string;
  readonly initial: string;
  readonly value: string;
  readonly end: boolean;
  readonly onChange: (iso: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const id = useId();
  const [text, setText] = useState(initial);
  const [invalid, setInvalid] = useState(false);
  const commit = (): void => {
    const trimmed = text.trim();
    if (!trimmed) {
      setInvalid(false);
      if (value) onChange('');
      return;
    }
    const day = parseDate(trimmed);
    if (!day) {
      setInvalid(true);
      return;
    }
    const iso = end ? dayEnd(day) : dayStart(day);
    if (iso !== value) onChange(iso);
  };
  return (
    <Field className='w-44' data-invalid={invalid ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        inputMode='numeric'
        autoComplete='off'
        placeholder={t('orderDocs.filters.datePlaceholder')}
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
      {invalid ? (
        <FieldError>{t('orderDocs.errors.dateInvalid')}</FieldError>
      ) : null}
    </Field>
  );
}
