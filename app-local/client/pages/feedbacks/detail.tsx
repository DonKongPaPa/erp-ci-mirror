import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, useParams } from 'react-router';

import { RouteDialog } from '#components/route-dialog';
import { useRouteOverlay } from '#components/use-route-overlay';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Skeleton } from '#components/ui/skeleton';
import { StatusBadge } from '#components/status-badge';

import { FeedbackClient, type FeedbackRow } from './client.js';
import { DiscardControl } from './discard.js';
import {
  FeedbackSheetForm,
  type FeedbackFormValues,
} from './FeedbackSheetForm.js';
import { FQC_RESOURCE } from './page-id.js';
import { feedbackErrorText } from './reasons.js';

/**
 * 详情与编辑。只持「提交反馈」的人进不来：看到一句说明，不发业务请求，也没有会落库的按钮。
 * 原文只读，更正走备注；改字段与丢弃只在 `maintain` 且端点算出的 `canEdit` / `canDiscard` 为真时出现。
 */
export default function FeedbackDetailPage(): ReactElement {
  const { t } = useTranslation();
  return (
    <RouteDialog title={t('feedbacks.form.titleEdit')}>
      <FeedbackDetailSheet />
    </RouteDialog>
  );
}

function FeedbackDetailSheet(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const { feedbackId = '' } = useParams();
  const api = useApiClient();
  const toaster = useToaster();
  const { close } = useRouteOverlay();
  const client = useMemo(() => new FeedbackClient(api), [api]);
  const maintain = useCan({ resource: FQC_RESOURCE, action: 'maintain' });

  const [item, setItem] = useState<FeedbackRow>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  const load = useCallback(
    () => client.get(feedbackId),
    [client, feedbackId],
  );

  useEffect(() => {
    if (!maintain.can) return;
    let active = true;
    load().then(
      (result) => {
        if (active) setItem(result);
      },
      (next: unknown) => {
        if (active) setError(feedbackErrorText(next, t));
      },
    );
    return () => {
      active = false;
    };
  }, [load, maintain.can, reloadToken, t]);

  const onSave = async (values: FeedbackFormValues): Promise<void> => {
    if (!item) return;
    setSaving(true);
    try {
      const {
        channel: _channel,
        content: _content,
        senderName: _senderName,
        senderContact: _senderContact,
        ...update
      } = values;
      const updated = await client.update(item.id, update);
      setItem(updated);
      toaster.show({ type: 'success', title: t('feedbacks.form.saved') });
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      {maintain.isPending ? (
        <p role='status' className='flex items-center gap-2 text-sm'>
          <Loader2 className='size-4 animate-spin' />
          {t('feedbacks.loading')}
        </p>
      ) : !maintain.can ? (
        <p role='status' className='text-sm text-muted-foreground'>
          {t('feedbacks.detailNoAccess')}
        </p>
      ) : !item ? (
        error ? (
          <Alert variant='destructive' role='alert'>
            <AlertTriangle className='size-4' />
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        ) : (
          <div aria-busy='true' className='flex flex-col gap-3'>
            <Skeleton className='h-4 w-1/2' />
            <Skeleton className='h-4 w-full' />
            <Skeleton className='h-4 w-2/3' />
          </div>
        )
      ) : (
        <div className='flex flex-col gap-4'>
          <div className='flex flex-wrap items-center gap-2'>
            <StatusBadge tone={item.status === 'open' ? 'info' : 'neutral'} size='sm'>
              {t(`feedbacks.status.${item.status}`)}
            </StatusBadge>
            <StatusBadge tone='neutral' size='sm'>
              {t('feedbacks.detail.submitter', { name: item.submitterName ?? '-' })}
            </StatusBadge>
            <span className='text-xs text-muted-foreground'>
              {new Intl.DateTimeFormat(locale, { dateStyle: 'medium' }).format(
                new Date(item.createdAt),
              )}
            </span>
          </div>

          {item.screening ? (
            <div className='rounded-md border bg-muted/30 p-3 text-sm'>
              <p className='font-medium'>{t('feedbacks.detail.screening')}</p>
              <p className='text-muted-foreground'>
                {t('feedbacks.detail.screeningSummary', {
                  outcome: t(`feedbacks.outcomes.${item.screening.outcome}`, {
                    defaultValue: item.screening.outcome,
                  }),
                  summary: item.screening.summary ?? '-',
                })}
              </p>
            </div>
          ) : null}
          {item.ticket ? (
            <div className='flex items-center gap-2 text-sm'>
              <StatusBadge tone='info' size='sm'>
                {t('feedbacks.detail.ticket', { code: item.ticket.code })}
              </StatusBadge>
              <Button nativeButton={false} render={<Link to='/quality' />} variant='outline' size='sm'>
                {t('feedbacks.detail.goConfirm')}
              </Button>
            </div>
          ) : null}
          {item.attachments.length > 0 ? (
            <ul className='flex flex-wrap gap-3 text-sm'>
              {item.attachments.map((file) => (
                <li key={file.id}>
                  <a className='underline' href={file.url}>
                    {file.filename}
                  </a>
                </li>
              ))}
            </ul>
          ) : null}

          {item.canEdit ? (
            <FeedbackSheetForm
              mode='edit'
              client={client}
              feedback={item}
              saving={saving}
              onSave={onSave}
              onCancel={() => void close()}
            />
          ) : (
            <p role='status' className='text-sm text-muted-foreground'>
              {t('feedbacks.detail.readOnly')}
            </p>
          )}

          {item.canDiscard ? (
            <DiscardControl
              item={item}
              client={client}
              onDiscarded={() => setReloadToken((value) => value + 1)}
            />
          ) : null}
        </div>
      )}
    </>
  );
}
