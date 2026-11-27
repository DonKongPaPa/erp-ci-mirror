import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { FormApi, FormField, ReadonlyField } from '#components/erp/form-dialog';
import { Input } from '#components/ui/input';

import type { Unit } from './client.js';
import { FormRows } from './form-parts.js';
import type { UnitFormValues } from './model.js';

/**
 * 计量单位表单的字段，新建与编辑共用：编码、名称、小数位。字段少，用窄对话框。
 * 编辑时编码画成只读的（建时定、不改、不复用）。
 */
export function UnitFields({
  form,
  unit,
}: {
  readonly form: FormApi<UnitFormValues>;
  /** 传了就是编辑：只读的编码从这里出。 */
  readonly unit?: Unit;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  return (
    <FormRows>
      {unit ? (
        <ReadonlyField label={t('erp.fields.code')} value={unit.code} />
      ) : (
        <FormField
          name='code'
          label={t('erp.fields.code')}
          required
          hint={t('items.units.codeHint')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              autoComplete='off'
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
            aria-invalid={invalid}
            value={values.name}
            onChange={(event) => form.set('name', event.target.value)}
          />
        )}
      </FormField>
      <FormField
        name='decimals'
        label={t('items.columns.decimals')}
        hint={t('items.units.decimalsHint')}
      >
        {(id, invalid) => (
          <Input
            id={id}
            type='number'
            inputMode='numeric'
            min={0}
            max={10}
            step={1}
            aria-invalid={invalid}
            className='w-28'
            value={values.decimals}
            onChange={(event) => form.set('decimals', event.target.value)}
          />
        )}
      </FormField>
    </FormRows>
  );
}
