import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  CheckRow,
  FormApi,
  FormField,
  FormGrid,
} from '#components/erp/form-dialog';
import { Input } from '#components/ui/input';

import type { ContactFormValues } from './model.js';

/** 联系人表单的字段，添加与编辑共用。 */
export function ContactFormFields({
  form,
}: {
  readonly form: FormApi<ContactFormValues>;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  return (
    <FormGrid>
      <FormField name='name' label={t('erp.fields.name')} required>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.name}
            onChange={(event) => form.set('name', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='title' label={t('partners.contact.title')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.title}
            onChange={(event) => form.set('title', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='phone' label={t('erp.fields.phone')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.phone}
            onChange={(event) => form.set('phone', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='email' label={t('erp.fields.email')}>
        {(id, invalid) => (
          <Input
            id={id}
            type='email'
            aria-invalid={invalid}
            value={values.email}
            onChange={(event) => form.set('email', event.target.value)}
          />
        )}
      </FormField>
      <div className='flex min-h-8 items-center sm:col-span-2'>
        <CheckRow
          label={t('partners.contact.setPrimary')}
          checked={values.isPrimary}
          onCheckedChange={(checked) => form.set('isPrimary', checked)}
        />
      </div>
    </FormGrid>
  );
}
