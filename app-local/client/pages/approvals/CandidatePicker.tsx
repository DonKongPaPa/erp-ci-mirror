import { useTranslation } from '@nocobase/i18n/client';
import {
  useEffect,
  useRef,
  useState,
  type ReactElement,
} from 'react';

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
import { Skeleton } from '#components/ui/skeleton';
import { Textarea } from '#components/ui/textarea';

import type { ApprovalsClient, CandidateRow } from './client.js';

/**
 * 转交与加签的选人弹窗。候选人只走本任务的 candidates 端点，返回只有标识、姓名、用户名；
 * 页面只显示姓名，不拿别的用户接口拼邮箱或手机号。转交单选、加签多选，搜索防抖 300 毫秒。
 */
export function CandidatePicker({
  taskId,
  type,
  client,
  onClose,
  onConfirm,
}: {
  readonly taskId: string;
  readonly type: 'delegate' | 'add';
  readonly client: ApprovalsClient;
  readonly onClose: () => void;
  readonly onConfirm: (body: {
    readonly ids: readonly string[];
    readonly comment: string;
    readonly position?: 'before' | 'after';
  }) => void;
}): ReactElement {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<readonly CandidateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [comment, setComment] = useState('');
  const [position, setPosition] = useState<'before' | 'after'>('before');
  const [submitting, setSubmitting] = useState(false);
  const tokenRef = useRef(0);

  useEffect(() => {
    const token = ++tokenRef.current;
    const timer = setTimeout(() => {
      void client.candidates(taskId, type, q).then(
        (page) => {
          if (tokenRef.current !== token) return;
          setRows(page.data);
          setError(undefined);
          setLoading(false);
        },
        (next: unknown) => {
          if (tokenRef.current !== token) return;
          setRows([]);
          setError(next);
          setLoading(false);
        },
      );
    }, 300);
    return () => {
      // 防抖计时器与过期响应都在这里收掉，不让它写已经关掉的弹窗。
      clearTimeout(timer);
      tokenRef.current += 1;
    };
  }, [client, taskId, type, q]);

  const toggle = (id: string) => {
    if (type === 'delegate') {
      setSelected([id]);
      return;
    }
    setSelected((old) =>
      old.includes(id) ? old.filter((item) => item !== id) : [...old, id],
    );
  };

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
            if (selected.length === 0) return;
            setSubmitting(true);
            try {
              onConfirm({
                ids: selected,
                comment,
                ...(type === 'add' ? { position } : {}),
              });
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {t(type === 'delegate' ? 'approvals.delegate.title' : 'approvals.addSign.title')}
            </DialogTitle>
            <DialogDescription>
              {t(
                type === 'delegate'
                  ? 'approvals.delegate.description'
                  : 'approvals.addSign.description',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className='flex flex-col gap-3'>
            <Label htmlFor='approval-candidate-search'>
              {t('approvals.candidates.search')}
            </Label>
            <Input
              id='approval-candidate-search'
              type='search'
              aria-label={t('approvals.candidates.search')}
              value={q}
              onChange={(event) => {
                setLoading(true);
                setQ(event.target.value);
              }}
            />
            {error ? (
              <p role='alert' className='text-sm text-destructive'>
                {t('approvals.candidates.loadFailed')}
              </p>
            ) : null}
            <div className='flex max-h-56 flex-col gap-1 overflow-auto'>
              {loading ? (
                <Skeleton className='h-8 w-full' />
              ) : rows.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  {t('approvals.candidates.empty')}
                </p>
              ) : (
                rows.map((row) => (
                  <Button
                    key={row.id}
                    type='button'
                    variant='outline'
                    aria-pressed={selected.includes(row.id)}
                    onClick={() => toggle(row.id)}
                    className='justify-start font-normal'
                  >
                    {row.name ?? t('approvals.timeline.unknownPerson')}
                  </Button>
                ))
              )}
            </div>
            {type === 'add' ? (
              <div className='flex flex-col gap-1'>
                <Label>{t('approvals.addSign.position')}</Label>
                <Select value={position} onValueChange={(value) => setPosition(value as 'before' | 'after')}>
                  <SelectTrigger aria-label={t('approvals.addSign.position')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value='before'>
                      {t('approvals.addSign.before')}
                    </SelectItem>
                    <SelectItem value='after'>
                      {t('approvals.addSign.after')}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            ) : null}
            <div className='flex flex-col gap-1'>
              <Label htmlFor='approval-candidate-comment'>
                {t('approvals.actions.comment')}
              </Label>
              <Textarea
                id='approval-candidate-comment'
                aria-label={t('approvals.actions.comment')}
                value={comment}
                onChange={(event) => setComment(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button type='button' variant='outline' onClick={onClose}>
              {t('approvals.actions.cancel')}
            </Button>
            <Button type='submit' disabled={selected.length === 0 || submitting}>
              {t('approvals.actions.confirm')}
            </Button>
          </DialogFooter>
        </FeedbackForm>
      </DialogContent>
    </Dialog>
  );
}
