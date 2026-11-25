import { useSubmission, useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { useState, type ReactElement } from 'react';
import { RowActions } from '#components/row-actions';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog';
import { Button } from '#components/ui/button';

/**
 * 密钥行末尾的「⋮」：轮换与吊销，都要先说明影响再确认。
 *
 * 两个页面共用。轮换的回调返回新明文；吊销没有返回值。吊销成功给一句成功提示 ——
 * 吊销既不是重放也不涉及明文。「重放」的提示只属于轮换：服务端真正重放时不会再带
 * 明文，这时才提示用户需要新明文请再轮换。每个请求带一个由 `useSubmission` 生成的
 * 幂等键：应用密钥的端点要求它，个人密钥的端点忽略它。
 */
export function ApiKeyRowActions({
  keyId,
  keyName,
  canRotate,
  onSecret,
  onChanged,
  rotate,
  revoke,
}: {
  readonly keyId: string;
  readonly keyName: string;
  readonly canRotate: boolean;
  readonly onSecret: (secret: string) => void;
  readonly onChanged: () => void;
  readonly rotate: (idempotencyKey: string) => Promise<string | undefined>;
  readonly revoke: (idempotencyKey: string) => Promise<void>;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const [action, setAction] = useState<'rotate' | 'revoke'>();
  const [error, setError] = useState(false);
  const submission = useSubmission({ scope: `${keyId}:api-key` });
  const busy = submission.submitting;
  const run = async () => {
    if (!action) return;
    setError(false);
    try {
      const outcome = await submission.run({ action }, async (key) => {
        if (action === 'rotate') return { secret: await rotate(key) };
        await revoke(key);
        return { secret: undefined };
      });
      if (!outcome) return;
      if (action === 'revoke') {
        // 吊销的结果与重放无关：无论服务端是否重放收据，密钥都不再可用。
        toaster.show({
          type: 'success',
          title: t('apiKeys.common.revoked'),
        });
      } else if (outcome.secret) {
        onSecret(outcome.secret);
      } else {
        toaster.show({
          type: 'info',
          title: t('apiKeys.common.replayed'),
        });
      }
      setAction(undefined);
      onChanged();
    } catch {
      setError(true);
    }
  };
  return (
    <>
      <RowActions
        label={t('apiKeys.common.actionsFor', { name: keyName })}
        actions={[
          canRotate && {
            key: 'rotate',
            label: t('apiKeys.common.rotate'),
            onClick: () => setAction('rotate'),
          },
          {
            key: 'revoke',
            label: t('apiKeys.common.revoke'),
            onClick: () => setAction('revoke'),
          },
        ]}
      />
      <AlertDialog
        open={Boolean(action)}
        onOpenChange={(open) => {
          if (!open && !busy) setAction(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {action === 'rotate'
                ? t('apiKeys.common.rotateTitle', { name: keyName })
                : t('apiKeys.common.revokeTitle', { name: keyName })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {action === 'rotate'
                ? t('apiKeys.common.rotateHint')
                : t('apiKeys.common.revokeHint')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error ? (
            <p role='alert' className='text-sm text-destructive'>
              {t('apiKeys.common.failed')}
            </p>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>
              {t('apiKeys.common.cancel')}
            </AlertDialogCancel>
            <Button
              variant='destructive'
              disabled={busy}
              onClick={() => void run()}
            >
              {busy
                ? t('apiKeys.common.saving')
                : t(
                    action === 'rotate'
                      ? 'apiKeys.common.rotate'
                      : 'apiKeys.common.revoke',
                  )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
