import { useTranslation } from '@nocobase/i18n/client';
import { useState, type ReactElement } from 'react';

import { FeedbackForm } from '#components/feedback-form';
import {
  personChoices,
  type PersonOption,
} from '#components/erp/options';
import { Button } from '#components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '#components/ui/dialog';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';

/** 结束盘点：财务填监盘人。只有持 stocktakings.finish 的人才看得到这个对话框。 */
export function FinishDialog({
  people,
  busy,
  error,
  onClose,
  onConfirm,
}: {
  readonly people: readonly PersonOption[];
  readonly busy: boolean;
  readonly error?: string;
  readonly onClose: () => void;
  readonly onConfirm: (supervisorUserId: string) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [supervisor, setSupervisor] = useState('');
  const opts = personChoices(people);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
      }}
    >
      <DialogContent>
        <FeedbackForm
          onSubmit={(event) => {
            event.preventDefault();
            if (supervisor) onConfirm(supervisor);
          }}
        >
          <DialogHeader>
            <DialogTitle>{t('stocktaking.finishTitle')}</DialogTitle>
            <DialogDescription>
              {t('stocktaking.finishDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='stocktaking-supervisor'>
              {t('stocktaking.fields.supervisor')}
            </Label>
            <Select
              value={supervisor || undefined}
              onValueChange={(value) => setSupervisor(value ?? '')}
              disabled={busy}
            >
              <SelectTrigger
                id='stocktaking-supervisor'
                aria-label={t('stocktaking.fields.supervisor')}
              >
                <SelectValue placeholder={t('stocktaking.form.choose')} />
              </SelectTrigger>
              <SelectContent>
                {opts.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {error ? (
              <p role='alert' className='text-sm text-destructive'>
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' disabled={busy} onClick={onClose}>
              {t('actions.cancel')}
            </Button>
            <Button type='submit' disabled={busy || !supervisor}>
              {t('stocktaking.actions.finish')}
            </Button>
          </DialogFooter>
        </FeedbackForm>
      </DialogContent>
    </Dialog>
  );
}
