import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement, type ReactNode } from 'react';

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

import type { RequestStatus } from './client.js';
import type { Choice } from '../orders/reference.js';

/** 空值占位：不把服务端没算出来的合计当 0。 */
export function Dash(): ReactElement {
  return <span className='text-muted-foreground'>—</span>;
}

const TONES: Readonly<
  Record<RequestStatus, 'neutral' | 'info' | 'success' | 'warning'>
> = {
  draft: 'neutral',
  approving: 'info',
  approved: 'success',
  rejected: 'warning',
  void: 'neutral',
  converted: 'success',
};

/** 状态徽标：颜色只是辅助，文字写明状态。 */
export function RequestStatusBadge({
  status,
}: {
  readonly status: RequestStatus;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={TONES[status] ?? 'neutral'}>
      {t(`purchaseRequests.status.${status}`)}
    </StatusBadge>
  );
}

/** 可填字段：标签在上，必填有星号，错误与提示在控件下面。 */
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

/** 下拉字段：标签与控件绑同一个 id，错误照常标在下面。 */
export function SelectField({
  id,
  label,
  required,
  error,
  value,
  onChange,
  options,
  placeholder,
  disabled,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly required?: boolean;
  readonly error?: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly options: readonly Choice[];
  readonly placeholder?: string;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <PageField id={id} label={label} required={required} error={error}>
      <Select
        items={[...options]}
        value={value || undefined}
        onValueChange={(value) => onChange(value ?? '')}
        disabled={disabled}
      >
        <SelectTrigger id={id} aria-label={typeof label === 'string' ? label : undefined}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </PageField>
  );
}

/** 表格里的一格输入：错了标在下面。 */
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

/** 明细里的数字输入，统一关掉浏览器自带的上下箭头。 */
export function NumberInput({
  id,
  label,
  value,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <Input
      id={id}
      inputMode='decimal'
      autoComplete='off'
      aria-label={label}
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
