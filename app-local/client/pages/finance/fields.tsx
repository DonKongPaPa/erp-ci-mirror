import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement, ReactNode } from 'react';

import { StatusBadge } from '#components/status-badge';
import {
  Field,
  FieldError,
  FieldLabel,
} from '#components/ui/field';

import type { FinanceRecord } from './client.js';

export function Dash(): ReactElement {
  return <span className='text-muted-foreground'>—</span>;
}

/** 财务记录的状态徽标：草稿灰、已登记绿、已作废灰（带字）。 */
export function FinanceStatusBadge({
  record,
}: {
  readonly record: Pick<FinanceRecord, 'status'>;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={record.status === 'confirmed' ? 'success' : 'neutral'}>
      {t(`finance.status.${record.status}`)}
    </StatusBadge>
  );
}

/** 一个可填字段：标签在上面，必填的加星号，错了在下面标出来。 */
export function FinanceField({
  id,
  label,
  required,
  error,
  className,
  children,
}: {
  readonly id: string;
  readonly label: ReactNode;
  readonly required?: boolean;
  readonly error?: string;
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
    </Field>
  );
}
