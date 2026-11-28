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

import type { RequestDocType, RequestStatus } from './client.js';

/** 空值占位：不把服务端没有的码当成 0 或空串显示。 */
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
      {t(`financeRequestDocs.status.${status}`)}
    </StatusBadge>
  );
}

/** 单据类型徽标：请款与报销共用一张表，列表与详情都要写明是哪一种。 */
export function RequestDocTypeBadge({
  docType,
}: {
  readonly docType: RequestDocType;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone='neutral'>
      {t(`financeRequestDocs.docTypes.${docType}`)}
    </StatusBadge>
  );
}

export interface Choice {
  readonly value: string;
  readonly label: string;
  readonly disabled?: boolean;
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
  hint,
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
  readonly hint?: ReactNode;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <PageField id={id} label={label} required={required} error={error} hint={hint}>
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

/** 金额输入：统一关掉浏览器自带的上下箭头。 */
export function AmountInput({
  id,
  value,
  onChange,
  disabled,
}: {
  readonly id: string;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}): ReactElement {
  return (
    <Input
      id={id}
      inputMode='decimal'
      autoComplete='off'
      disabled={disabled}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}
