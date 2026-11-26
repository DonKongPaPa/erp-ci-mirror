import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { Loader2, Paperclip, X } from 'lucide-react';
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { RadioGroup, RadioGroupItem } from '#components/ui/radio-group';
import { Textarea } from '#components/ui/textarea';

import {
  FeedbackClient,
  type FeedbackRow,
  type UploadedFeedbackFile,
} from './client.js';
import { feedbackErrorText } from './reasons.js';

const MAX_ATTACHMENTS = 10;

export interface FeedbackFormValues {
  readonly channel: 'web' | 'proxy';
  readonly customerName?: string | null;
  readonly senderName?: string | null;
  readonly senderContact?: string | null;
  readonly productName?: string | null;
  readonly model?: string | null;
  readonly batchNo?: string | null;
  readonly content: string;
  readonly note?: string | null;
  readonly attachmentIds: readonly string[];
}

interface Props {
  readonly mode: 'create' | 'edit';
  readonly client: FeedbackClient;
  readonly feedback?: FeedbackRow;
  readonly saving: boolean;
  readonly onSave: (values: FeedbackFormValues) => Promise<void> | void;
  readonly onCancel: () => void;
}

/**
 * 业务反馈单的表单。名字刻意不叫 `FeedbackForm` —— 那是框架的表单出错提示组件。
 * 原文只在新建时可填：落库后不可改，更正走备注。
 *
 * 附件：S4 的上传端点已并入主线；类型和大小只做前端提示，判定在服务端。
 */
export function FeedbackSheetForm({
  mode,
  client,
  feedback,
  saving,
  onSave,
  onCancel,
}: Props): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [channel, setChannel] = useState<'web' | 'proxy'>(
    feedback?.customerName ? 'proxy' : 'web',
  );
  const [customerName, setCustomerName] = useState(feedback?.customerName ?? '');
  const [senderName, setSenderName] = useState('');
  const [senderContact, setSenderContact] = useState('');
  const [productName, setProductName] = useState(feedback?.productName ?? '');
  const [model, setModel] = useState(feedback?.model ?? '');
  const [batchNo, setBatchNo] = useState(feedback?.batchNo ?? '');
  const [content, setContent] = useState(feedback?.content ?? '');
  const [note, setNote] = useState(feedback?.note ?? '');
  const [files, setFiles] = useState<readonly UploadedFeedbackFile[]>(
    feedback?.attachments.map(({ id, filename, mimeType, size }) => ({
      id,
      filename,
      mimeType,
      size,
    })) ?? [],
  );
  const [uploading, setUploading] = useState(0);
  const [validationError, setValidationError] = useState<string>();
  const [serverError, setServerError] = useState<string>();
  const formRef = useRef<HTMLFormElement>(null);

  const submitLabel =
    mode === 'create' ? t('feedbacks.form.submit') : t('feedbacks.form.save');
  const proxy = channel === 'proxy';
  const busy = saving || uploading > 0;

  const upload = useCallback(
    async (picked: FileList | null) => {
      if (!picked || picked.length === 0) return;
      setServerError(undefined);
      // 先截再传：多出来的文件不上传，免得留下没人引用的孤儿文件。
      const accepted = [...picked].slice(
        0,
        Math.max(0, MAX_ATTACHMENTS - files.length),
      );
      setUploading((count) => count + accepted.length);
      try {
        const uploaded = await Promise.all(
          accepted.map((file) => client.upload(file)),
        );
        setFiles((previous) => [...previous, ...uploaded]);
      } catch (error) {
        // 413/415 等由 reasons.ts 映射成用户能看懂的一句话。
        setServerError(feedbackErrorText(error, t));
      } finally {
        setUploading((count) => Math.max(0, count - accepted.length));
      }
    },
    [client, files.length, t],
  );

  const fileSize = useCallback(
    (size: number) =>
      new Intl.NumberFormat(locale, {
        style: 'unit',
        unit: 'byte',
        unitDisplay: 'narrow',
      }).format(size),
    [locale],
  );

  const submit = async (): Promise<void> => {
    setValidationError(undefined);
    setServerError(undefined);
    if (proxy && !customerName.trim()) {
      setValidationError(t('feedbacks.errors.customerRequired'));
      return;
    }
    if (mode === 'create' && !content.trim()) {
      setValidationError(t('feedbacks.form.contentRequired'));
      return;
    }
    // 服务端「不带键是不动、传 null 是清掉」：编辑态把清空的文本字段显式发 null，
    // 新建态继续省略空字段。
    const textValue = (value: string): string | null | undefined => {
      const trimmed = value.trim();
      if (trimmed) return trimmed;
      return mode === 'edit' ? null : undefined;
    };
    const values: FeedbackFormValues = {
      channel,
      ...(proxy || mode === 'edit'
        ? {
            customerName: textValue(customerName),
            senderName: senderName.trim() || undefined,
            senderContact: senderContact.trim() || undefined,
          }
        : {}),
      productName: textValue(productName),
      model: textValue(model),
      batchNo: textValue(batchNo),
      content: mode === 'create' ? content.trim() : content,
      note: textValue(note),
      attachmentIds: files.map((file) => file.id),
    };
    // 告诉外层 overlay 保存正在进行：保存成功后由 onSave 关窗，这时候不能再问「丢弃修改？」。
    // 未保存就离开仍然会问 —— 那个问题由 RouteOverlay 自己管。
    const form = formRef.current;
    const announce = (phase: 'start' | 'end'): void => {
      if (!form?.isConnected) return;
      form.dispatchEvent(
        new CustomEvent('nocobase:form-submit', {
          bubbles: true,
          detail: { phase },
        }),
      );
    };
    announce('start');
    try {
      await onSave(values);
    } catch (error) {
      setServerError(feedbackErrorText(error, t));
    } finally {
      announce('end');
    }
  };

  const fields = useMemo(() => {
    const text = (
      key: string,
      value: string,
      change: (next: string) => void,
    ) => (
      <div className='flex flex-col gap-1' key={key}>
        <Label htmlFor={`feedback-${key}`}>{t(`feedbacks.form.${key}`)}</Label>
        <Input
          id={`feedback-${key}`}
          value={value}
          onChange={(event) => change(event.target.value)}
        />
      </div>
    );
    return (
      <div className='grid gap-3 sm:grid-cols-2'>
        {proxy
          ? [
              text('customerName', customerName, setCustomerName),
              text('senderName', senderName, setSenderName),
              text('senderContact', senderContact, setSenderContact),
            ]
          : null}
        {text('productName', productName, setProductName)}
        {text('model', model, setModel)}
        {text('batchNo', batchNo, setBatchNo)}
      </div>
    );
  }, [proxy, customerName, senderName, senderContact, productName, model, batchNo, t]);

  return (
    <form
      ref={formRef}
      className='flex flex-col gap-4'
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {mode === 'create' ? (
        <fieldset className='flex flex-wrap gap-4'>
          <legend className='text-sm font-medium'>
            {t('feedbacks.form.source')}
          </legend>
          <RadioGroup
            className='flex flex-row gap-4'
            value={channel}
            onValueChange={(value) => setChannel(value as 'web' | 'proxy')}
          >
            <label className='flex items-center gap-2 text-sm'>
              <RadioGroupItem
                value='web'
                aria-label={t('feedbacks.form.sourceSelf')}
              />
              {t('feedbacks.form.sourceSelf')}
            </label>
            <label className='flex items-center gap-2 text-sm'>
              <RadioGroupItem
                value='proxy'
                aria-label={t('feedbacks.form.sourceProxy')}
              />
              {t('feedbacks.form.sourceProxy')}
            </label>
          </RadioGroup>
        </fieldset>
      ) : null}

      {fields}

      <div className='flex flex-col gap-1'>
        <Label htmlFor='feedback-content'>{t('feedbacks.form.content')}</Label>
        {mode === 'edit' ? (
          <>
            <p
              data-testid='feedback-original'
              className='whitespace-pre-wrap rounded-md border bg-muted/40 p-3 text-sm leading-6'
            >
              {content}
            </p>
            <p className='text-xs text-muted-foreground'>
              {t('feedbacks.form.contentReadonly')}
            </p>
          </>
        ) : (
          <Textarea
            id='feedback-content'
            value={content}
            onChange={(event) => setContent(event.target.value)}
            rows={5}
            className='resize-y'
          />
        )}
      </div>

      {mode === 'edit' ? (
        <div className='flex flex-col gap-1'>
          <Label htmlFor='feedback-note'>{t('feedbacks.form.note')}</Label>
          <Textarea
            id='feedback-note'
            value={note}
            onChange={(event) => setNote(event.target.value)}
            rows={3}
            className='resize-y'
          />
        </div>
      ) : null}

      <div className='flex flex-col gap-2'>
        <Label htmlFor='feedback-attachments'>
          {t('feedbacks.form.attachments')}
        </Label>
        <p className='text-xs text-muted-foreground'>
          {t('feedbacks.form.attachmentHint')}
        </p>
        <Input
          id='feedback-attachments'
          type='file'
          multiple
          accept='.jpg,.jpeg,.png,.webp,.pdf'
          disabled={files.length >= MAX_ATTACHMENTS || busy}
          onChange={(event) => void upload(event.target.files)}
        />
        {uploading > 0 ? (
          <p role='status' className='flex items-center gap-2 text-sm'>
            <Loader2 className='size-4 animate-spin' />
            {t('feedbacks.form.uploading')}
          </p>
        ) : null}
        <ul className='flex flex-col gap-1'>
          {files.map((file) => (
            <li key={file.id} className='flex items-center gap-2 text-sm'>
              <Paperclip className='size-4 shrink-0' />
              <span className='truncate'>{file.filename}</span>
              <span className='text-xs text-muted-foreground'>
                {fileSize(file.size)}
              </span>
              <Button
                type='button'
                variant='ghost'
                size='sm'
                aria-label={`${t('feedbacks.form.removeAttachment')} ${file.filename}`}
                onClick={() =>
                  setFiles((previous) =>
                    previous.filter((item) => item.id !== file.id),
                  )
                }
              >
                <X className='size-4' />
              </Button>
            </li>
          ))}
        </ul>
      </div>

      {validationError ? (
        <Alert variant='destructive' role='alert'>
          <AlertDescription>{validationError}</AlertDescription>
        </Alert>
      ) : null}
      {serverError ? (
        <Alert variant='destructive' role='alert'>
          <AlertDescription>{serverError}</AlertDescription>
        </Alert>
      ) : null}

      <div className='flex items-center gap-2'>
        <Button type='submit' disabled={busy}>
          {busy ? <Loader2 data-icon='inline-start' className='animate-spin' /> : null}
          {submitLabel}
        </Button>
        <Button type='button' variant='outline' onClick={onCancel}>
          {t('actions.cancel')}
        </Button>
      </div>
    </form>
  );
}

export default FeedbackSheetForm;
