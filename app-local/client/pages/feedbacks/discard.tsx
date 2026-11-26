import { useToaster } from '@nocobase/app-client';
import { useTranslation } from '@nocobase/i18n/client';
import { Loader2 } from 'lucide-react';
import { useState, type ReactElement } from 'react';

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '#components/ui/alert-dialog';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

import { FeedbackClient, type DiscardReason, type FeedbackRow } from './client.js';
import { feedbackErrorText } from './reasons.js';

const REASONS: readonly DiscardReason[] = ['not-defect', 'duplicate', 'other'];

/** 丢弃必须先确认并选原因；已有工单时服务端回 409，页面把原因说清楚并保留这张单。 */
export function DiscardControl({
  item,
  client,
  onDiscarded,
}: {
  readonly item: FeedbackRow;
  readonly client: FeedbackClient;
  readonly onDiscarded: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const toaster = useToaster();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<DiscardReason>('not-defect');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const confirm = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.discard(item.id, reason);
      setOpen(false);
      toaster.show({ type: 'success', title: t('feedbacks.form.discarded') });
      onDiscarded();
    } catch (next) {
      setError(feedbackErrorText(next, t));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Button
        variant='outline'
        size='sm'
        disabled={!item.canDiscard}
        onClick={() => {
          setError(undefined);
          setOpen(true);
        }}
      >
        {t('feedbacks.form.discard')}
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('feedbacks.form.discardTitle')}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t('feedbacks.form.discardDescription')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='feedback-discard-reason'>
              {t('feedbacks.form.discardReason')}
            </Label>
            <Select
              items={REASONS.map((value) => ({
                value,
                label: t(`feedbacks.form.discardReasons.${value}`),
              }))}
              value={reason}
              onValueChange={(value) => setReason(value as DiscardReason)}
            >
              <SelectTrigger aria-label={t('feedbacks.form.discardReason')}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {REASONS.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`feedbacks.form.discardReasons.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error ? (
            <Alert variant='destructive' role='alert'>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <AlertDialogFooter>
            <AlertDialogCancel>{t('actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void confirm()} disabled={saving}>
              {saving ? <Loader2 className='size-4 animate-spin' /> : null}
              {t('feedbacks.form.discardConfirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export default DiscardControl;
