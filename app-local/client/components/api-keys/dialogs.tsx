import { copyText, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { AlertTriangle } from 'lucide-react';
import { useState, type ReactElement, type ReactNode } from 'react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Input } from '#components/ui/input';
import { Label } from '#components/ui/label';
import { Textarea } from '#components/ui/textarea';

/** 创建密钥的入参：名称必填，用途可选，过期天数按页面要求。 */
export interface ApiKeyDraft {
  readonly name: string;
  readonly description?: string;
  /** `null` 表示永不过期；应用密钥的页面上不允许为空。 */
  readonly expiresInDays: number | null;
}

/**
 * 上一次提交的结果未知时的提示与两条出路：原样重试（同一个幂等键），或到列表里
 * 核对过、确实没有这一行（解锁表单，下一次提交用新的幂等键）。
 *
 * 「原样重试」只在页面还留着上一次提交的内容时才给 —— 没有可重放的内容就只剩核对。
 */
export function OutcomeUnknownAlert({
  busy,
  onRetry,
  onAcknowledge,
}: {
  readonly busy: boolean;
  readonly onRetry?: () => void;
  readonly onAcknowledge: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
    <Alert variant='destructive' data-testid='api-key-outcome-unknown'>
      <AlertTriangle className='size-4' />
      <AlertDescription className='flex flex-col items-start gap-2'>
        <p>{t('apiKeys.common.outcomeUnknown')}</p>
        <div className='flex flex-wrap gap-2'>
          {onRetry ? (
            <Button
              variant='outline'
              size='sm'
              disabled={busy}
              onClick={onRetry}
            >
              {t('apiKeys.common.retryOriginal')}
            </Button>
          ) : null}
          <Button
            variant='outline'
            size='sm'
            disabled={busy}
            onClick={onAcknowledge}
          >
            {t('apiKeys.common.acknowledgeNotCommitted')}
          </Button>
        </div>
      </AlertDescription>
    </Alert>
  );
}

/**
 * 创建一把密钥的对话框。两个密钥页面共用：字段、有效期规则与确认方式都一样，
 * 只有「过期天数必填吗」不同（个人密钥可以永不过期，应用密钥必须过期）。
 */
export function CreateApiKeyDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly description: string;
  readonly expiryRequired: boolean;
  readonly defaultDays?: number;
  readonly busy: boolean;
  readonly error?: ReactNode;
  /** 上一次提交的结果未知：表单锁住，只留重试与核对两条出路。 */
  readonly pending: boolean;
  readonly onRetry?: () => void;
  readonly onAcknowledge: () => void;
  readonly onCancel: () => void;
  readonly onSubmit: (draft: ApiKeyDraft) => void;
}): ReactElement {
  return (
    <Dialog
      open={props.open}
      onOpenChange={(next) => {
        if (!next && !props.busy) props.onCancel();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{props.title}</DialogTitle>
          <DialogDescription>{props.description}</DialogDescription>
        </DialogHeader>
        {/* 表单只在打开时挂载，每次打开都是空的；不用 effect 重置字段。 */}
        {props.open ? (
          <>
            {props.pending ? (
              <OutcomeUnknownAlert
                busy={props.busy}
                onRetry={props.onRetry}
                onAcknowledge={props.onAcknowledge}
              />
            ) : null}
            <CreateApiKeyForm {...props} locked={props.pending} />
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateApiKeyForm({
  expiryRequired,
  defaultDays = 90,
  busy,
  locked,
  error,
  onCancel,
  onSubmit,
}: {
  readonly expiryRequired: boolean;
  readonly defaultDays?: number;
  readonly busy: boolean;
  readonly locked: boolean;
  readonly error?: ReactNode;
  readonly onCancel: () => void;
  readonly onSubmit: (draft: ApiKeyDraft) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [purpose, setPurpose] = useState('');
  const [days, setDays] = useState(String(defaultDays));
  const parsedDays = days.trim() === '' ? null : Number(days);
  const daysInvalid =
    parsedDays !== null &&
    (!Number.isInteger(parsedDays) || parsedDays < 1 || parsedDays > 365);
  const daysMissing = expiryRequired && parsedDays === null;
  const canSubmit =
    name.trim().length > 0 && !daysInvalid && !daysMissing && !busy && !locked;
  return (
    <>
      <form
        id='api-key-create'
        className='flex flex-col gap-4'
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit) return;
          onSubmit({
            name: name.trim(),
            ...(purpose.trim() ? { description: purpose.trim() } : {}),
            expiresInDays: parsedDays,
          });
        }}
      >
        <div className='flex flex-col gap-2'>
          <Label htmlFor='api-key-name'>{t('apiKeys.common.name')}</Label>
          <Input
            id='api-key-name'
            // eslint-disable-next-line jsx-a11y/no-autofocus -- 密钥对话框打开时把焦点放进首个字段，是弹层的默认焦点，不是页面加载时抢焦点
            autoFocus
            value={name}
            maxLength={128}
            disabled={locked}
            placeholder={t('apiKeys.common.namePlaceholder')}
            onChange={(event) => setName(event.target.value)}
          />
        </div>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='api-key-purpose'>{t('apiKeys.common.purpose')}</Label>
          <Textarea
            id='api-key-purpose'
            value={purpose}
            maxLength={500}
            disabled={locked}
            placeholder={t('apiKeys.common.purposePlaceholder')}
            onChange={(event) => setPurpose(event.target.value)}
          />
        </div>
        <div className='flex flex-col gap-2'>
          <Label htmlFor='api-key-days'>{t('apiKeys.common.validity')}</Label>
          <Input
            id='api-key-days'
            type='number'
            min={1}
            max={365}
            step={1}
            value={days}
            disabled={locked}
            aria-describedby='api-key-days-hint'
            onChange={(event) => setDays(event.target.value)}
          />
          <p
            id='api-key-days-hint'
            className={
              daysInvalid || daysMissing
                ? 'text-sm text-destructive'
                : 'text-sm text-muted-foreground'
            }
          >
            {daysInvalid || daysMissing
              ? t('apiKeys.common.invalidDays')
              : expiryRequired
                ? t('apiKeys.common.daysRequired')
                : t('apiKeys.common.daysOptional')}
          </p>
        </div>
        {error ? (
          <p role='alert' className='text-sm text-destructive'>
            {error}
          </p>
        ) : null}
      </form>
      <DialogFooter>
        <Button variant='outline' disabled={busy} onClick={onCancel}>
          {t('apiKeys.common.cancel')}
        </Button>
        <Button type='submit' form='api-key-create' disabled={!canSubmit}>
          {busy ? t('apiKeys.common.saving') : t('apiKeys.common.create')}
        </Button>
      </DialogFooter>
    </>
  );
}

/**
 * 签发或轮换成功后只显示一次的明文。关闭后就看不到了；丢了只能轮换。
 */
export function SecretDialog({
  open,
  title,
  secret,
  onClose,
}: {
  readonly open: boolean;
  readonly title: string;
  readonly secret: string;
  readonly onClose: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const copy = async () => {
    try {
      if (await copyText(secret)) {
        toaster.show({
          type: 'success',
          title: t('apiKeys.common.copied'),
        });
        return;
      }
    } catch {
      // 剪贴板不可用时让用户手动复制，不假装成功。
    }
    toaster.show({
      type: 'error',
      title: t('apiKeys.common.copyFailed'),
    });
  };
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {t('apiKeys.common.secretHint')}
          </DialogDescription>
        </DialogHeader>
        <Input
          readOnly
          value={secret}
          aria-label={t('apiKeys.common.secret')}
          className='font-mono'
          onFocus={(event) => event.target.select()}
        />
        <DialogFooter>
          <Button variant='outline' onClick={() => void copy()}>
            {t('apiKeys.common.copy')}
          </Button>
          <Button onClick={onClose}>{t('apiKeys.common.done')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
