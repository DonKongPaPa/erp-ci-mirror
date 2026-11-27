import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  FormApi,
  FormField,
  FormGrid,
  FormGroupField,
  ReadonlyField,
  CheckRow,
} from '#components/erp/form-dialog';
import { Input } from '#components/ui/input';
import { Textarea } from '#components/ui/textarea';

import type { Partner } from './client.js';
import type { PartnerFormValues } from './model.js';

/**
 * 往来单位表单的字段，新建与编辑共用。新建时类型是两个勾选框（只有建得了的那一种才画）；
 * 编辑时编码和类型不能改，画成只读的。
 */
export function PartnerFields({
  form,
  partner,
  customerCreate = false,
  supplierCreate = false,
}: {
  readonly form: FormApi<PartnerFormValues>;
  /** 传了就是编辑：只读的编码与类型从这里出。 */
  readonly partner?: Partner;
  readonly customerCreate?: boolean;
  readonly supplierCreate?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  const text = (
    name: 'contactName' | 'phone' | 'email' | 'taxId' | 'address',
    label: string,
  ) => (
    <FormField
      name={name}
      label={label}
      className={name === 'address' ? 'sm:col-span-2' : undefined}
    >
      {(id, invalid) => (
        <Input
          id={id}
          aria-invalid={invalid}
          value={values[name]}
          onChange={(event) => form.set(name, event.target.value)}
        />
      )}
    </FormField>
  );
  return (
    <FormGrid>
      <FormField
        name='name'
        label={t('erp.fields.name')}
        required
        className='sm:col-span-2'
      >
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.name}
            onChange={(event) => form.set('name', event.target.value)}
          />
        )}
      </FormField>
      {partner ? (
        <>
          <ReadonlyField label={t('erp.fields.code')} value={partner.code} />
          <ReadonlyField
            label={t('erp.fields.type')}
            value={
              [
                partner.isCustomer ? t('partners.kind.customer') : '',
                partner.isSupplier ? t('partners.kind.supplier') : '',
              ]
                .filter(Boolean)
                .join('、') || '—'
            }
          />
        </>
      ) : (
        <FormGroupField
          label={t('erp.fields.type')}
          required
          error={form.errors.kinds}
          hint={t('partners.form.kindsHint')}
          className='sm:col-span-2'
        >
          <div className='flex min-h-8 flex-wrap items-center gap-4'>
            {customerCreate ? (
              <CheckRow
                label={t('partners.kind.customer')}
                checked={values.isCustomer}
                onCheckedChange={(checked) => form.set('isCustomer', checked)}
              />
            ) : null}
            {supplierCreate ? (
              <CheckRow
                label={t('partners.kind.supplier')}
                checked={values.isSupplier}
                onCheckedChange={(checked) => form.set('isSupplier', checked)}
              />
            ) : null}
          </div>
        </FormGroupField>
      )}
      {text('contactName', t('erp.fields.contact'))}
      {text('phone', t('erp.fields.phone'))}
      {text('email', t('erp.fields.email'))}
      {text('taxId', t('erp.fields.taxId'))}
      {text('address', t('erp.fields.address'))}
      <FormField
        name='note'
        label={t('erp.fields.note')}
        className='sm:col-span-2'
      >
        {(id, invalid) => (
          <Textarea
            id={id}
            rows={2}
            aria-invalid={invalid}
            value={values.note}
            onChange={(event) => form.set('note', event.target.value)}
          />
        )}
      </FormField>
    </FormGrid>
  );
}
