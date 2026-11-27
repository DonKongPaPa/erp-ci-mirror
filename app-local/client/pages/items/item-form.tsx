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

import type { Item } from './client.js';
import {
  dictionaryOptions,
  type DictionaryOption,
  type ItemDictionaries,
} from './dictionaries.js';
import { FormSelect, type FormOption } from './form-parts.js';
import { itemTypeLabel, type ItemFormValues } from './model.js';

/** 下拉框里「不选分类」的值：契约收的是 `categoryCode: null`。 */
const NONE = '__none__';

/**
 * 在用的一本字典当选项；当前值已停用（不在在用的里面）时也留下它并标明，
 * 免得下拉框对不上当前值 —— 换不换由用户决定，服务端拒了会把那句话标在这一项下面。
 */
function activeOptions(
  options: readonly DictionaryOption[],
  entries: readonly { readonly code: string; readonly status: string }[],
  current: string,
): FormOption[] {
  return options.filter(
    (option, index) =>
      entries[index]?.status === 'active' || option.value === current,
  );
}

/**
 * 物料表单的字段，新建与编辑共用：名称、类型、规格型号、分类、基本单位、旧系统编码、备注。
 * 编辑时编码画成只读的（编码由系统发放，创建后不能修改）。带选择器，所以用宽对话框。
 */
export function ItemFields({
  form,
  item,
  dictionaries,
}: {
  readonly form: FormApi<ItemFormValues>;
  /** 传了就是编辑：只读的编码从这里出。 */
  readonly item?: Item;
  readonly dictionaries: ItemDictionaries;
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  const unitOptions = activeOptions(
    dictionaryOptions(dictionaries.units, t),
    dictionaries.units,
    values.unitCode,
  );
  const categoryOptions: FormOption[] = [
    { value: NONE, label: t('items.form.noCategory') },
    ...activeOptions(
      dictionaryOptions(dictionaries.categories, t),
      dictionaries.categories,
      values.categoryCode,
    ),
  ];
  const typeOptions: readonly FormOption[] = [
    { value: 'material', label: itemTypeLabel('material', t) },
    { value: 'product', label: itemTypeLabel('product', t) },
  ];
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
      {item ? (
        <ReadonlyField label={t('erp.fields.code')} value={item.code} />
      ) : null}
      <FormField name='itemType' label={t('erp.fields.type')} required>
        {(id, invalid) => (
          <FormSelect
            id={id}
            invalid={invalid}
            value={values.itemType}
            options={typeOptions}
            onChange={(next) =>
              form.set('itemType', next === 'product' ? 'product' : 'material')
            }
          />
        )}
      </FormField>
      <FormField name='spec' label={t('items.columns.spec')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.spec}
            onChange={(event) => form.set('spec', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='categoryCode' label={t('items.columns.category')}>
        {(id, invalid) => (
          <FormSelect
            id={id}
            invalid={invalid}
            value={values.categoryCode || NONE}
            options={categoryOptions}
            onChange={(next) =>
              form.set('categoryCode', next === NONE ? '' : next)
            }
          />
        )}
      </FormField>
      <FormField name='unitCode' label={t('items.columns.unit')} required>
        {(id, invalid) => (
          <FormSelect
            id={id}
            invalid={invalid}
            value={values.unitCode}
            options={unitOptions}
            onChange={(next) => form.set('unitCode', next)}
          />
        )}
      </FormField>
      <FormField name='legacyCode' label={t('items.columns.legacyCode')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.legacyCode}
            onChange={(event) => form.set('legacyCode', event.target.value)}
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
