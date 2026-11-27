import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import {
  FormApi,
  FormField,
  FormGrid,
  ReadonlyField,
} from '#components/erp/form-dialog';
import { Input } from '#components/ui/input';
import { cn } from 'cn';

import { breakRange, timeRange, type ShiftFormValues } from './model.js';
import type { Shift } from './client.js';

/** 时间按时分填的文本框：不挑浏览器，写法由提交前的校验把住。 */
function TimeInput({
  id,
  invalid,
  value,
  onChange,
  className,
}: {
  readonly id: string;
  readonly invalid: boolean;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly className?: string;
}): ReactElement {
  return (
    <Input
      id={id}
      inputMode='numeric'
      autoComplete='off'
      maxLength={5}
      placeholder='HH:MM'
      aria-invalid={invalid}
      className={cn('w-28', className)}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/**
 * 班次表单的字段，新建、编辑、复制新建共用。编辑时编码、时间段、休息段画成只读的
 * （只有名称、排序能改）；另外两种是整张可填的。
 */
export function ShiftFormFields({
  form,
  mode,
}: {
  readonly form: FormApi<ShiftFormValues>;
  readonly mode: 'new' | 'edit' | 'copy';
}): ReactElement {
  const { t } = useTranslation();
  const values = form.values;
  if (mode === 'edit') {
    return (
      <FormGrid>
        <ReadonlyField label={t('erp.fields.code')} value={values.id} />
        <FormField
          name='title'
          label={t('erp.fields.name')}
          required
          className='sm:col-span-2'
        >
          {(id, invalid) => (
            <Input
              id={id}
              aria-invalid={invalid}
              value={values.title}
              onChange={(event) => form.set('title', event.target.value)}
            />
          )}
        </FormField>
        <ReadonlyField label={t('shifts.form.start')} value={values.start} />
        <ReadonlyField label={t('shifts.form.end')} value={values.end} />
        <ReadonlyField
          label={t('shifts.form.break')}
          value={
            values.breakStart && values.breakEnd
              ? `${values.breakStart} – ${values.breakEnd}`
              : '—'
          }
        />
        <FormField
          name='sortOrder'
          label={t('erp.fields.sortOrder')}
          hint={t('shifts.form.sortHint')}
        >
          {(id, invalid) => (
            <Input
              id={id}
              inputMode='numeric'
              aria-invalid={invalid}
              className='w-28'
              value={values.sortOrder}
              onChange={(event) => form.set('sortOrder', event.target.value)}
            />
          )}
        </FormField>
      </FormGrid>
    );
  }
  return (
    <FormGrid>
      <FormField
        name='id'
        label={
          mode === 'copy' ? t('shifts.form.newCode') : t('erp.fields.code')
        }
        required
        hint={t('shifts.form.codeHint')}
      >
        {(id, invalid) => (
          <Input
            id={id}
            autoComplete='off'
            aria-invalid={invalid}
            className='uppercase'
            value={values.id}
            onChange={(event) =>
              form.set('id', event.target.value.toUpperCase())
            }
          />
        )}
      </FormField>
      <FormField name='title' label={t('erp.fields.name')} required>
        {(id, invalid) => (
          <Input
            id={id}
            aria-invalid={invalid}
            value={values.title}
            onChange={(event) => form.set('title', event.target.value)}
          />
        )}
      </FormField>
      <FormField name='start' label={t('shifts.form.start')} required>
        {(id, invalid) => (
          <TimeInput
            id={id}
            invalid={invalid}
            value={values.start}
            onChange={(value) => form.set('start', value)}
          />
        )}
      </FormField>
      <FormField
        name='end'
        label={t('shifts.form.end')}
        required
        hint={t('shifts.form.crossHint')}
      >
        {(id, invalid) => (
          <TimeInput
            id={id}
            invalid={invalid}
            value={values.end}
            onChange={(value) => form.set('end', value)}
          />
        )}
      </FormField>
      <FormField name='breakStart' label={t('shifts.form.breakStart')}>
        {(id, invalid) => (
          <TimeInput
            id={id}
            invalid={invalid}
            value={values.breakStart}
            onChange={(value) => form.set('breakStart', value)}
          />
        )}
      </FormField>
      <FormField name='breakEnd' label={t('shifts.form.breakEnd')}>
        {(id, invalid) => (
          <TimeInput
            id={id}
            invalid={invalid}
            value={values.breakEnd}
            onChange={(value) => form.set('breakEnd', value)}
          />
        )}
      </FormField>
      <FormField
        name='sortOrder'
        label={t('erp.fields.sortOrder')}
        hint={t('shifts.form.sortHint')}
      >
        {(id, invalid) => (
          <Input
            id={id}
            inputMode='numeric'
            aria-invalid={invalid}
            className='w-28'
            value={values.sortOrder}
            onChange={(event) => form.set('sortOrder', event.target.value)}
          />
        )}
      </FormField>
    </FormGrid>
  );
}

/** 复制新建时上面那块旧班次的只读信息。 */
export function ShiftSourceNotice({
  shift,
}: {
  readonly shift: Shift;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <p className='rounded-lg border border-border bg-muted/50 px-3 py-2 text-sm'>
      <span className='font-medium'>
        {t('shifts.form.source', { code: shift.id, title: shift.title })}
      </span>
      <span className='text-muted-foreground'>
        {timeRange(shift)}
        {shift.breakStartMinute !== null && shift.breakEndMinute !== null
          ? `，${t('shifts.form.break')} ${breakRange(shift)}`
          : ''}
      </span>
    </p>
  );
}
