import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement, ReactNode } from 'react';

import { StatusBadge } from '#components/status-badge';
import { Field, FieldError, FieldLabel } from '#components/ui/field';

import type { ReconStatus } from './client.js';

export function Dash(): ReactElement {
  return <span className='text-muted-foreground'>—</span>;
}

/** 单据状态：草稿灰、已登记绿、已作废灰（带字）。 */
export function DocStatusBadge({ status }: { readonly status: string }): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={status === 'confirmed' ? 'success' : 'neutral'}>
      {t(`reconciliation.status.${status}`)}
    </StatusBadge>
  );
}

/** 核销状态由两列金额算：未核销、部分核销、已核销。 */
export function ReconStatusBadge({ status }: { readonly status: ReconStatus }): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={status === 'settled' ? 'success' : status === 'partial' ? 'warning' : 'neutral'}>
      {t(`reconciliation.reconStatusValues.${status}`)}
    </StatusBadge>
  );
}

export function ReconField({
  id, label, required, error, className, children,
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
        {required ? <span aria-hidden='true' className='text-destructive'>*</span> : null}
      </FieldLabel>
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
