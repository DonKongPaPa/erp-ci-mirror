import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { FormApi, FormField, ReadonlyField } from '#components/erp/form-dialog';
import { Input } from '#components/ui/input';

import type { Category } from './client.js';
import type { ItemDictionaries } from './dictionaries.js';
import { FormSelect, FormRows } from './form-parts.js';
import {
  NO_PARENT,
  parentOptions,
  type CategoryFormValues,
} from './model.js';

/**
 * 物料分类表单的字段，新建与编辑共用：编码、名称、上级分类。字段少，用窄对话框。
 * 编辑时编码画成只读的（建时定、不改）。
 */
export function CategoryFields({
  form,
  category,
  dictionaries,
}: {
  readonly form: FormApi<CategoryFormValues>;
  /** 传了就是编辑：只读的编码从这里出。 */
  readonly category?: Category;
  readonly dictionaries: ItemDictionaries;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  const options = parentOptions(dictionaries, category?.id, values.parentId, t);
  return (
    <FormRows>
      {category ? (
        <ReadonlyField label={t('erp.fields.code')} value={category.code} />
      ) : (
        <FormField
          name='code'
          label={t('erp.fields.code')}
          required
          hint={t('items.categories.codeHint')}
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
      <FormField name='sort' label={t('items.categories.sort')}>
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
      <FormField
        name='parentId'
        label={t('items.columns.parent')}
        hint={t('items.categories.parentHint')}
      >
        {(id, invalid) => (
          <FormSelect
            id={id}
            invalid={invalid}
            value={values.parentId || NO_PARENT}
            options={options}
            onChange={(next) =>
              form.set('parentId', next === NO_PARENT ? '' : next)
            }
          />
        )}
      </FormField>
    </FormRows>
  );
}
