import { useTranslation } from '@nocobase/i18n/client';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useState,
  type FormEvent,
  type ReactElement,
  type ReactNode,
} from 'react';

import { FeedbackForm } from '#components/feedback-form';
import { PendingButton } from '#components/pending-button';
import { RouteDialog } from '#components/route-dialog';
import { useRouteOverlay } from '#components/use-route-overlay';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Checkbox } from '#components/ui/checkbox';
import { Label } from '#components/ui/label';
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from '#components/ui/field';
import { cn } from 'cn';

import { errorText, type Translate } from './messages.js';
import { usePageLeave } from '../../routing/route-leave-boundary.js';

/**
 * 主数据的新建与编辑对话框（《基座ERP前端设计》2.2）：路由上的子页，标签在输入框上面，
 * 必填的加星号，提交时才校验，错了标在那一项下面，对话框不关、不清空；
 * 页脚「取消」在前，提交按钮在后。做了没保存就想离开会先问一句（`usePageLeave`）。
 */

/** 字段名 → 提示文字。 */
export type FieldErrors = Readonly<Record<string, string | undefined>>;

export interface FormApi<V> {
  readonly values: V;
  readonly set: <K extends keyof V & string>(key: K, value: V[K]) => void;
  readonly errors: FieldErrors;
  readonly busy: boolean;
}

export interface FormDialogProps<V, R> {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  /** 写明是「创建」还是「保存」。 */
  readonly submitLabel: ReactNode;
  readonly initialValues: V;
  /** 提交时才跑：返回「字段名 → 提示」；有一项就不发请求，光标落到第一项。 */
  readonly validate?: (values: V) => FieldErrors;
  readonly save: (values: V) => Promise<R>;
  /** 服务端收下了：提示、刷新列表都在这里做，之后对话框自己关。 */
  readonly onSuccess: (result: R) => unknown;
  /** 被拒时哪个规则码落到哪一项下面（编码重复就把光标放到编码上）。 */
  readonly fieldErrors?: (
    error: unknown,
    t: Translate,
  ) => FieldErrors | undefined;
  /** 控件 1 到 4 个用窄的（`narrow`），字段多或带选择器的用宽的（默认）。 */
  readonly size?: 'narrow' | 'wide';
  readonly children: (form: FormApi<V>) => ReactNode;
}

interface FormContextValue {
  readonly formId: string;
  readonly errors: FieldErrors;
}

const FormContext = createContext<FormContextValue | null>(null);

function useForm(): FormContextValue {
  const value = useContext(FormContext);
  if (!value)
    throw new Error('Form fields must be rendered inside FormDialog.');
  return value;
}

/** 整个对话框就是一个组件：页面的路由模块默认导出它，字段用渲染函数写。 */
export function FormDialog<V, R>({
  title,
  description,
  submitLabel,
  initialValues,
  validate,
  save,
  onSuccess,
  fieldErrors,
  size = 'wide',
  children,
}: FormDialogProps<V, R>): ReactElement {
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  return (
    <FormContext.Provider value={{ formId, errors }}>
      <RouteDialog
        title={title}
        description={description}
        className={size === 'narrow' ? 'sm:max-w-md' : undefined}
        footer={
          <FormDialogFooter
            formId={formId}
            submitLabel={submitLabel}
            busy={busy}
          />
        }
      >
        <FormDialogBody
          initialValues={initialValues}
          validate={validate}
          save={save}
          onSuccess={onSuccess}
          fieldErrors={fieldErrors}
          busy={busy}
          setBusy={setBusy}
          setErrors={setErrors}
          render={children}
        />
      </RouteDialog>
    </FormContext.Provider>
  );
}

function FormDialogBody<V, R>({
  initialValues,
  validate,
  save,
  onSuccess,
  fieldErrors,
  busy,
  setBusy,
  setErrors,
  render,
}: {
  readonly initialValues: V;
  readonly validate: FormDialogProps<V, R>['validate'];
  readonly save: FormDialogProps<V, R>['save'];
  readonly onSuccess: FormDialogProps<V, R>['onSuccess'];
  readonly fieldErrors: FormDialogProps<V, R>['fieldErrors'];
  readonly busy: boolean;
  readonly setBusy: (busy: boolean) => void;
  readonly setErrors: (update: (old: FieldErrors) => FieldErrors) => void;
  readonly render: FormDialogProps<V, R>['children'];
}): ReactElement {
  const { t } = useTranslation();
  // useRouteOverlay 要在 RouteDialog 的上下文里调用，所以表单逻辑放在对话框里面的这一层。
  const { close } = useRouteOverlay();
  const { formId, errors } = useForm();
  const [values, setValues] = useState<V>(initialValues);
  const [touched, setTouched] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();
  // 提交校验没过时把光标落到第一项；带一个时间戳，连着提交两次也会再落一次。
  const [focus, setFocus] = useState<{
    readonly key: string;
    readonly at: number;
  }>();
  const leave = usePageLeave(touched && !saved, busy);

  const set = useCallback(
    <K extends keyof V & string>(key: K, value: V[K]) => {
      setTouched(true);
      setValues((old) => ({ ...old, [key]: value }));
      // 改了哪一项，就把哪一项下面的提示收掉。
      setErrors((old) =>
        old[key] === undefined ? old : { ...old, [key]: undefined },
      );
    },
    [setErrors],
  );

  useEffect(() => {
    if (!focus) return;
    document.getElementById(`${formId}-${focus.key}`)?.focus();
  }, [focus, formId]);

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy) return;
    const found = validate?.(values) ?? {};
    setErrors(() => found);
    const first = Object.entries(found).find(([, message]) => message)?.[0];
    if (first !== undefined) {
      setFocus({ key: first, at: Date.now() });
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      const result = await save(values);
      await onSuccess(result);
      setSaved(true);
      // 保存成功了，关掉对话框不再问「放弃未保存的更改」。
      leave.allow();
      await close();
    } catch (next) {
      setError(errorText(next, t));
      setErrors(() => fieldErrors?.(next, t) ?? {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <FeedbackForm
        id={formId}
        onSubmit={(event) => void onSubmit(event)}
        className='flex flex-col gap-4'
      >
        {error ? (
          <Alert variant='destructive'>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : null}
        {render({ values, set, errors, busy })}
      </FeedbackForm>
      {leave.dialog}
    </>
  );
}

function FormDialogFooter({
  formId,
  submitLabel,
  busy,
}: {
  readonly formId: string;
  readonly submitLabel: ReactNode;
  readonly busy: boolean;
}): ReactElement {
  const { t } = useTranslation();
  const { close } = useRouteOverlay();
  return (
    <>
      <Button variant='outline' disabled={busy} onClick={() => void close()}>
        {t('actions.cancel')}
      </Button>
      <PendingButton type='submit' form={formId} busy={busy}>
        {submitLabel}
      </PendingButton>
    </>
  );
}

/** 两列的字段栅格；要占满一整行的字段加 `sm:col-span-2`。 */
export function FormGrid({
  children,
}: {
  readonly children: ReactNode;
}): ReactElement {
  return (
    <FieldGroup className='gap-x-4 sm:grid sm:grid-cols-2'>
      {children}
    </FieldGroup>
  );
}

/** 一个可填的字段：标签在上面，必填的加星号，错了在下面标出来。控件用渲染函数拿 `id` 与是否出错。 */
export function FormField({
  name,
  label,
  required,
  hint,
  className,
  children,
}: {
  readonly name: string;
  readonly label: ReactNode;
  readonly required?: boolean;
  readonly hint?: ReactNode;
  readonly className?: string;
  readonly children: (id: string, invalid: boolean) => ReactNode;
}): ReactElement {
  const { formId, errors } = useForm();
  const id = `${formId}-${name}`;
  const message = errors[name];
  return (
    <Field className={className} data-invalid={message ? true : undefined}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? (
          <span aria-hidden='true' className='text-destructive'>
            *
          </span>
        ) : null}
      </FieldLabel>
      {children(id, Boolean(message))}
      {message ? <FieldError>{message}</FieldError> : null}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** 一组控件当一项（两个勾选框的类型）：标签不带 `htmlFor`，控件自己带无障碍名称。 */
export function FormGroupField({
  label,
  required,
  hint,
  error,
  className,
  children,
}: {
  readonly label: ReactNode;
  readonly required?: boolean;
  readonly hint?: ReactNode;
  readonly error?: string;
  readonly className?: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <Field className={className} data-invalid={error ? true : undefined}>
      <FieldLabel>
        {label}
        {required ? (
          <span aria-hidden='true' className='text-destructive'>
            *
          </span>
        ) : null}
      </FieldLabel>
      {children}
      {error ? <FieldError>{error}</FieldError> : null}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/** 只读的字段（编码、类型、起止时间这一类不能改的）：画成填不进去的样子，不是灰掉的输入框。 */
export function ReadonlyField({
  label,
  value,
  className,
}: {
  readonly label: ReactNode;
  readonly value: ReactNode;
  readonly className?: string;
}): ReactElement {
  return (
    <Field className={className}>
      <FieldLabel>{label}</FieldLabel>
      <div className='flex min-h-8 items-center rounded-lg border border-border bg-muted/50 px-2.5 text-sm'>
        <span className='wrap-anywhere'>{value}</span>
      </div>
    </Field>
  );
}

/** 给一组里的勾选框排成一行，高度与输入框一样。 */
export function CheckRow({
  checked,
  label,
  onCheckedChange,
  className,
}: {
  readonly checked: boolean;
  readonly label: string;
  readonly onCheckedChange: (checked: boolean) => void;
  readonly className?: string;
}): ReactElement {
  return (
    <Label
      className={cn('h-8 w-fit items-center gap-2 font-normal', className)}
    >
      <Checkbox
        aria-label={label}
        checked={checked}
        onCheckedChange={(next) => onCheckedChange(next === true)}
      />
      {label}
    </Label>
  );
}
