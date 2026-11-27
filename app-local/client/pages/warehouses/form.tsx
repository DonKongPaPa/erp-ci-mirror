import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  FormApi,
  FormField,
  FormGrid,
  ReadonlyField,
} from '#components/erp/form-dialog';
import { Input } from '#components/ui/input';
import { Textarea } from '#components/ui/textarea';

import type { WarehouseFormValues } from './model.js';

/**
 * 仓库表单的字段，新建与编辑共用。编辑时短码画成只读的（建好后不能改）；窄对话框，三个控件。
 */
export function WarehouseFormFields({
  form,
  mode,
}: {
  readonly form: FormApi<WarehouseFormValues>;
  readonly mode: 'new' | 'edit';
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  return (
    <FormGrid>
      {mode === 'edit' ? (
        <ReadonlyField label={t('erp.fields.code')} value={values.code} />
      ) : (
        <FormField
          name='code'
          label={t('erp.fields.code')}
          required
          hint={t('warehouses.form.codeHint')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              autoComplete='off'
              maxLength={32}
              aria-invalid={invalid}
              className='uppercase'
              value={values.code}
              onChange={(event) =>
                form.set('code', event.target.value.toUpperCase())
              }
            />
          )}
        </FormField>
      )}
      <FormField name='name' label={t('erp.fields.name')} required>
        {(id, invalid) => (
          <Input
            id={id}
            maxLength={128}
            aria-invalid={invalid}
            value={values.name}
            onChange={(event) => form.set('name', event.target.value)}
          />
        )}
      </FormField>
      <FormField
        name='note'
        label={t('erp.fields.note')}
        className='sm:col-span-2'
      >
        {(id, invalid) => (
          <Textarea
            id={id}
            maxLength={500}
            aria-invalid={invalid}
            value={values.note}
            onChange={(event) => form.set('note', event.target.value)}
          />
        )}
      </FormField>
    </FormGrid>
  );
}
