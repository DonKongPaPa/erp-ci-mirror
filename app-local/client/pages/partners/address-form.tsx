import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  CheckRow,
  FormApi,
  FormField,
  FormGrid,
  FormGroupField,
} from '#components/erp/form-dialog';
import { Textarea } from '#components/ui/textarea';

import type { AddressFormValues } from './model.js';

/** 交货地址表单：详细地址必填；新建时可以顺手设为默认，编辑时不改默认（那是单独的动作）。 */
export function AddressFields({
  form,
  showDefault = true,
}: {
  readonly form: FormApi<AddressFormValues>;
  readonly showDefault?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  return (
    <FormGrid>
      <FormField
        name='address'
        label={t('partners.address.address')}
        required
        className='sm:col-span-2'
      >
        {(id, invalid) => (
          <Textarea
            id={id}
            rows={2}
            aria-invalid={invalid}
            value={values.address}
            onChange={(event) => form.set('address', event.target.value)}
          />
        )}
      </FormField>
      {showDefault ? (
        <FormGroupField label={t('partners.address.isDefault')}>
          <CheckRow
            label={t('partners.address.isDefault')}
            checked={values.isDefault}
            onCheckedChange={(checked) => form.set('isDefault', checked)}
          />
        </FormGroupField>
      ) : null}
    </FormGrid>
  );
}
