import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  CheckRow,
  FormApi,
  FormField,
  FormGrid,
  FormGroupField,
  ReadonlyField,
} from '#components/erp/form-dialog';
import { Input } from '#components/ui/input';
import { Textarea } from '#components/ui/textarea';

import type { Entry } from './client.js';
import { usesProjectFields, usesRate, type EntryFormValues } from './model.js';

/** 字典取值的表单，新建与编辑共用；类型决定多出来的那几列，码建成后只读。 */
export function EntryFields({
  form,
  dictType,
  entry,
}: {
  readonly form: FormApi<EntryFormValues>;
  readonly dictType: string;
  /** 传了就是编辑：码画成只读的。 */
  readonly entry?: Entry;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  return (
    <FormGrid>
      {entry ? (
        <ReadonlyField
          label={t('erp.fields.code')}
          value={entry.code}
          className='sm:col-span-2'
        />
      ) : (
        <FormField
          name='code'
          label={t('erp.fields.code')}
          required
          hint={t('bizDict.form.codeHint')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              autoComplete='off'
              aria-invalid={invalid}
              value={values.code}
              onChange={(event) => form.set('code', event.target.value)}
            />
          )}
        </FormField>
      )}
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
      {usesRate(dictType) ? (
        <FormField name='rate' label={t('bizDict.fields.rate')}>
          {(id, invalid) => (
            <Input
              id={id}
              type='number'
              min={0}
              max={100}
              step='0.01'
              aria-invalid={invalid}
              value={values.rate}
              onChange={(event) => form.set('rate', event.target.value)}
            />
          )}
        </FormField>
      ) : null}
      {usesProjectFields(dictType) ? (
        <>
          <FormField name='startDate' label={t('bizDict.fields.startDate')}>
            {(id, invalid) => (
              // ui-component-exception: 项目尚无日期选择器与日历依赖，本片沿用仓库与库存页的原生日期输入（D-056），不在这一片补 DatePicker
              <Input
                id={id}
                type='date'
                aria-invalid={invalid}
                value={values.startDate}
                onChange={(event) => form.set('startDate', event.target.value)}
              />
            )}
          </FormField>
          <FormField name='endDate' label={t('bizDict.fields.endDate')}>
            {(id, invalid) => (
              // ui-component-exception: 项目尚无日期选择器与日历依赖，本片沿用仓库与库存页的原生日期输入（D-056），不在这一片补 DatePicker
              <Input
                id={id}
                type='date'
                aria-invalid={invalid}
                value={values.endDate}
                onChange={(event) => form.set('endDate', event.target.value)}
              />
            )}
          </FormField>
          <FormField
            name='description'
            label={t('bizDict.fields.description')}
            className='sm:col-span-2'
          >
            {(id, invalid) => (
              <Textarea
                id={id}
                rows={2}
                aria-invalid={invalid}
                value={values.description}
                onChange={(event) =>
                  form.set('description', event.target.value)
                }
              />
            )}
          </FormField>
        </>
      ) : null}
      <FormField name='sort' label={t('bizDict.fields.sort')}>
        {(id, invalid) => (
          <Input
            id={id}
            type='number'
            min={0}
            step='1'
            aria-invalid={invalid}
            value={values.sort}
            onChange={(event) => form.set('sort', event.target.value)}
          />
        )}
      </FormField>
      <FormGroupField label={t('bizDict.fields.isDefault')}>
        <CheckRow
          label={t('bizDict.fields.isDefault')}
          checked={values.isDefault}
          onCheckedChange={(checked) => form.set('isDefault', checked)}
        />
      </FormGroupField>
    </FormGrid>
  );
}
