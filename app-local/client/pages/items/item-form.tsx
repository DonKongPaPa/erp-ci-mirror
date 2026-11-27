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
  canViewPurchasePrice = false,
  canViewSalesPrice = false,
}: {
  readonly form: FormApi<ItemFormValues>;
  /** 传了就是编辑：只读的编码从这里出。 */
  readonly item?: Item;
  readonly dictionaries: ItemDictionaries;
  /** 两个基准价各由自己的动作控制；没有动作时不画输入框，也不拿空值占成 0。 */
  readonly canViewPurchasePrice?: boolean;
  readonly canViewSalesPrice?: boolean;
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
  const otherUnits = dictionaries.units.filter(
    (unit) => unit.code !== values.unitCode,
  );
  const auxOptions: FormOption[] = [
    { value: NONE, label: t('items.form.noAuxUnit') },
    ...activeOptions(dictionaryOptions(otherUnits, t), otherUnits, values.auxUnitCode),
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
      <FormField name='englishName' label={t('items.columns.englishName')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.englishName}
            onChange={(event) => form.set('englishName', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='stockMin' label={t('items.columns.stockMin')}>
        {(id, invalid) => (
          <Input
            id={id}
            type='number'
            min={0}
            step='any'
            aria-invalid={invalid}
            value={values.stockMin}
            onChange={(event) => form.set('stockMin', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='stockMax' label={t('items.columns.stockMax')}>
        {(id, invalid) => (
          <Input
            id={id}
            type='number'
            min={0}
            step='any'
            aria-invalid={invalid}
            value={values.stockMax}
            onChange={(event) => form.set('stockMax', event.target.value)}
          />
        )}
      </FormField>
      {canViewPurchasePrice ? (
        <FormField
          name='basePurchasePrice'
          label={t('items.columns.basePurchasePrice')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              type='number'
              min={0}
              step='any'
              aria-invalid={invalid}
              value={values.basePurchasePrice}
              onChange={(event) =>
                form.set('basePurchasePrice', event.target.value)
              }
            />
          )}
        </FormField>
      ) : null}
      {canViewSalesPrice ? (
        <FormField
          name='baseSalesPrice'
          label={t('items.columns.baseSalesPrice')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              type='number'
              min={0}
              step='any'
              aria-invalid={invalid}
              value={values.baseSalesPrice}
              onChange={(event) =>
                form.set('baseSalesPrice', event.target.value)
              }
            />
          )}
        </FormField>
      ) : null}
      <FormField name='barcode' label={t('items.columns.barcode')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.barcode}
            onChange={(event) => form.set('barcode', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='brand' label={t('items.columns.brand')}>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.brand}
            onChange={(event) => form.set('brand', event.target.value)}
          />
        )}
      </FormField>
      <FormField
        name='manufacturerModel'
        label={t('items.columns.manufacturerModel')}
      >
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.manufacturerModel}
            onChange={(event) =>
              form.set('manufacturerModel', event.target.value)
            }
          />
        )}
      </FormField>
      <FormField name='auxUnitCode' label={t('items.columns.auxUnit')}>
        {(id, invalid) => (
          <FormSelect
            id={id}
            invalid={invalid}
            value={values.auxUnitCode || NONE}
            options={auxOptions}
            onChange={(next) =>
              form.set('auxUnitCode', next === NONE ? '' : next)
            }
          />
        )}
      </FormField>
      <FormField name='unitRatio' label={t('items.columns.unitRatio')}>
        {(id, invalid) => (
          <Input
            id={id}
            type='number'
            min={0}
            step='any'
            aria-invalid={invalid}
            value={values.unitRatio}
            onChange={(event) => form.set('unitRatio', event.target.value)}
          />
        )}
      </FormField>
      <FormField
        name='purchaseLeadDays'
        label={t('items.columns.purchaseLeadDays')}
      >
        {(id, invalid) => (
          <Input
            id={id}
            type='number'
            min={0}
            max={3650}
            step='1'
            aria-invalid={invalid}
            value={values.purchaseLeadDays}
            onChange={(event) =>
              form.set('purchaseLeadDays', event.target.value)
            }
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
