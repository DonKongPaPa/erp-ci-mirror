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

import { FormSelect, type FormOption } from '../items/form-parts.js';
import type { Partner } from './client.js';
import type { PartnerDictionaries } from './dictionaries.js';
import type { PartnerFormValues } from './model.js';

/**
 * 往来单位表单的字段，新建与编辑共用。新建时类型是两个勾选框（只有建得了的那一种才画）；
 * 编辑时编码和类型不能改，画成只读的。
 */
export function PartnerFields({
  form,
  partner,
  options,
  customerCreate = false,
  supplierCreate = false,
}: {
  readonly form: FormApi<PartnerFormValues>;
  /** 传了就是编辑：只读的编码与类型从这里出。 */
  readonly partner?: Partner;
  /** 分组与人员下拉的选项；人员只有标识与姓名。 */
  readonly options: PartnerDictionaries;
  readonly customerCreate?: boolean;
  readonly supplierCreate?: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  // 编辑时按服务端回的键判侧：另一侧的数据根本没回，页面不自己推断着补。
  const showCustomer = partner ? 'customerGroupCode' in partner : customerCreate;
  const showSupplier = partner ? 'supplierGroupCode' in partner : supplierCreate;
  const none: FormOption = { value: '', label: t('partners.form.noSelection') };
  const customerGroups: readonly FormOption[] = [
    none,
    ...options.customerGroups
      .filter(
        (entry) =>
          entry.status === 'active' || entry.code === values.customerGroupCode,
      )
      .map((entry) => ({ value: entry.code, label: entry.name })),
  ];
  const supplierGroups: readonly FormOption[] = [
    none,
    ...options.supplierGroups
      .filter(
        (entry) =>
          entry.status === 'active' || entry.code === values.supplierGroupCode,
      )
      .map((entry) => ({ value: entry.code, label: entry.name })),
  ];
  const people: readonly FormOption[] = [
    none,
    ...options.people.map((person) => ({
      value: person.userId,
      label: person.name ?? person.userId,
    })),
  ];
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
      {showCustomer ? (
        <>
          <FormField
            name='customerGroupCode'
            label={t('partners.fields.customerGroup')}
          >
            {(id, invalid) => (
              <FormSelect
                id={id}
                invalid={invalid}
                value={values.customerGroupCode}
                options={customerGroups}
                onChange={(next) => form.set('customerGroupCode', next)}
              />
            )}
          </FormField>
          <FormField
            name='salespersonUserId'
            label={t('partners.fields.salesperson')}
          >
            {(id, invalid) => (
              <FormSelect
                id={id}
                invalid={invalid}
                value={values.salespersonUserId}
                options={people}
                onChange={(next) => form.set('salespersonUserId', next)}
              />
            )}
          </FormField>
        </>
      ) : null}
      {showSupplier ? (
        <>
          <FormField
            name='supplierGroupCode'
            label={t('partners.fields.supplierGroup')}
          >
            {(id, invalid) => (
              <FormSelect
                id={id}
                invalid={invalid}
                value={values.supplierGroupCode}
                options={supplierGroups}
                onChange={(next) => form.set('supplierGroupCode', next)}
              />
            )}
          </FormField>
          <FormField
            name='buyerUserId'
            label={t('partners.fields.buyer')}
          >
            {(id, invalid) => (
              <FormSelect
                id={id}
                invalid={invalid}
                value={values.buyerUserId}
                options={people}
                onChange={(next) => form.set('buyerUserId', next)}
              />
            )}
          </FormField>
          <FormField
            name='payeeAccountNo'
            label={t('partners.fields.payeeAccountNo')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid}
                value={values.payeeAccountNo}
                onChange={(event) =>
                  form.set('payeeAccountNo', event.target.value)
                }
              />
            )}
          </FormField>
          <FormField
            name='payeeBankName'
            label={t('partners.fields.payeeBankName')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid}
                value={values.payeeBankName}
                onChange={(event) =>
                  form.set('payeeBankName', event.target.value)
                }
              />
            )}
          </FormField>
          <FormField
            name='payeeBankCode'
            label={t('partners.fields.payeeBankCode')}
          >
            {(id, invalid) => (
              <Input
                id={id}
                aria-invalid={invalid}
                value={values.payeeBankCode}
                onChange={(event) =>
                  form.set('payeeBankCode', event.target.value)
                }
              />
            )}
          </FormField>
        </>
      ) : null}
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
