import { useTranslation } from '@nocobase/i18n/client';
import { useState, type ReactElement } from 'react';

import { FeedbackForm } from '#components/feedback-form';
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Textarea } from '#components/ui/textarea';

import type { ApprovalDetail } from './client.js';
import { snapshotText } from './model.js';

export type SimpleAction = 'approve' | 'reject' | 'return' | 'withdraw' | 'abort' | 'resubmit';

export interface ActionBody {
  readonly comment?: string;
  readonly returnToNodeKey?: string;
  readonly data?: Record<string, unknown>;
}

/** 审批动作的确认框：意见可选，退回可指定节点，重新提交改快照里的键值。 */
export function ActionDialog({
  action,
  detail,
  onClose,
  onConfirm,
}: {
  readonly action: SimpleAction;
  readonly detail: ApprovalDetail;
  readonly onClose: () => void;
  readonly onConfirm: (body: ActionBody) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [comment, setComment] = useState('');
  const [returnToNodeKey, setReturnToNodeKey] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const round = detail.rounds.find((item) => item.round === detail.currentRound) ?? detail.rounds.at(-1);
  const snapshot = round?.snapshot ?? {};
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(snapshot).map(([key, value]) => [key, snapshotText(value)]),
    ),
  );
  const nodes = [...new Set(detail.records.map((record) => record.nodeKey))];
  const needsComment = action === 'approve' || action === 'reject' || action === 'return';

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !submitting) onClose();
      }}
    >
      <DialogContent>
        <FeedbackForm
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitting(true);
            try {
              onConfirm({
                ...(needsComment ? { comment } : {}),
                ...(action === 'return' && returnToNodeKey ? { returnToNodeKey } : {}),
                ...(action === 'resubmit' ? { data: { ...snapshot, ...values } } : {}),
              });
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{t(`approvals.actions.${action}`)}</DialogTitle>
            <DialogDescription>{t(`approvals.dialog.${action}`)}</DialogDescription>
          </DialogHeader>
          {needsComment ? (
            <div className='flex flex-col gap-1'>
              <Label htmlFor='approval-action-comment'>
                {t('approvals.actions.comment')}
              </Label>
              <Textarea
                id='approval-action-comment'
                aria-label={t('approvals.actions.comment')}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
          ) : null}
          {action === 'return' && nodes.length > 0 ? (
            <div className='flex flex-col gap-1'>
              <Label htmlFor='approval-action-node'>
                {t('approvals.actions.returnToNode')}
              </Label>
              <Select value={returnToNodeKey} onValueChange={(value) => setReturnToNodeKey(String(value ?? ''))}>
                <SelectTrigger id='approval-action-node' aria-label={t('approvals.actions.returnToNode')}>
                  <SelectValue placeholder={t('approvals.dialog.returnDefault')} />
                </SelectTrigger>
                <SelectContent>
                  {nodes.map((node) => (
                    <SelectItem key={node} value={node}>
                      {node}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {action === 'resubmit' ? (
            <div className='flex flex-col gap-2'>
              {Object.keys(values).map((key) => (
                <div key={key} className='flex flex-col gap-1'>
                  <Label htmlFor={`approval-resubmit-${key}`}>{key}</Label>
                  <Input
                    id={`approval-resubmit-${key}`}
                    value={values[key] ?? ''}
                    onChange={(event) =>
                      setValues((old) => ({ ...old, [key]: event.target.value }))
                    }
                  />
                </div>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              {t('approvals.actions.cancel')}
            </Button>
            <Button type='submit'>{t('approvals.actions.confirm')}</Button>
          </DialogFooter>
        </FeedbackForm>
      </DialogContent>
    </Dialog>
  );
}
