import { useApiClient, useToaster } from '@nocobase/app-client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { useEffect, useMemo, useState, type ReactElement } from 'react';

import { FeedbackForm } from '#components/feedback-form';
import { errorText } from '#components/erp/messages';
import { useListData } from '#hooks/use-list-data';
import {
  personChoices,
  usePersonOptions,
} from '#components/erp/options';
import { formatDateTime } from './model.js';
import { PendingButton } from '#components/pending-button';
import { Button } from '#components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '#components/ui/dialog';
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

import { type ReviewAccess } from './review-access.js';
import {
  OrderReviewsClient,
  REVIEW_FACTORS,
  type OrderReview,
  type ReviewFactor,
} from './review-client.js';

interface FactorDraft {
  readonly conclusion: string;
  readonly note: string;
}

const emptyFactors = (): Record<ReviewFactor, FactorDraft> => ({
  man: { conclusion: '', note: '' },
  machine: { conclusion: '', note: '' },
  material: { conclusion: '', note: '' },
  method: { conclusion: '', note: '' },
  environment: { conclusion: '', note: '' },
});

/** 销售订单详情的「订单评审」页签：计划填五项并确认交期，销售只读回传的日子。 */
export function OrderReviewPanel({
  salesOrderId,
  access,
}: {
  readonly salesOrderId: string;
  readonly access: ReviewAccess;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new OrderReviewsClient(api), [api]);
  const people = usePersonOptions(access.personOptions && access.create);

  const listPath = useMemo(() => {
    const query = new URLSearchParams({ salesOrderId, pageSize: '100' });
    return `order-reviews?${query.toString()}`;
  }, [salesOrderId]);
  const list = useListData<{ items: readonly OrderReview[] }>(listPath, {
    active: access.view,
  });
  const [choice, setChoice] = useState<string>();
  const [detail, setDetail] = useState<OrderReview>();
  const [detailError, setDetailError] = useState<unknown>();
  const [creating, setCreating] = useState(false);
  const [reviewer, setReviewer] = useState('');
  const [factors, setFactors] = useState<Record<ReviewFactor, FactorDraft>>(emptyFactors);
  const [confirming, setConfirming] = useState<OrderReview>();
  const [deliveryDate, setDeliveryDate] = useState('');
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string>();

  const reviews = list.data?.items ?? [];
  const selectedId =
    choice !== undefined && reviews.some((row) => row.id === choice)
      ? choice
      : reviews[0]?.id;
  const selected = detail?.id === selectedId ? detail : undefined;
  const loading = access.view && list.loading;
  const error = detailError ?? list.error;
  const confirmed = reviews.find((row) => row.status === 'confirmed');

  useEffect(() => {
    if (!access.view || selectedId === undefined) return;
    const controller = new AbortController();
    void client
      .detail(selectedId)
      .then((row) => {
        if (!controller.signal.aborted) setDetail(row);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setDetailError(cause);
      });
    return () => controller.abort();
  }, [access.view, client, selectedId]);

  const openCreate = (): void => {
    setReviewer('');
    setFactors(emptyFactors());
    setActionError(undefined);
    setCreating(true);
  };

  const create = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const missing = REVIEW_FACTORS.some((factor) => factors[factor].conclusion.trim() === '');
    if (missing || reviewer === '') {
      setActionError(t('orderReviews.factorsIncomplete'));
      return;
    }
    setBusy(true);
    setActionError(undefined);
    try {
      const row = await client.create({
        salesOrderId,
        reviewerUserId: reviewer,
        lines: REVIEW_FACTORS.map((factor) => ({
          factor,
          conclusion: factors[factor].conclusion.trim(),
          ...(factors[factor].note.trim() === ''
            ? {}
            : { note: factors[factor].note.trim() }),
        })),
      });
      setCreating(false);
      setDetail(row);
      setChoice(row.id);
      toaster.show({ type: 'success', title: t('orderReviews.created') });
      list.reload();
    } catch (cause) {
      setActionError(errorText(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const submit = async (row: OrderReview): Promise<void> => {
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await client.submit(row.id);
      setDetail(next);
      toaster.show({ type: 'success', title: t('orderReviews.submitted') });
      list.reload();
    } catch (cause) {
      setActionError(errorText(cause, t));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (event: React.FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (confirming === undefined || deliveryDate === '') return;
    setBusy(true);
    setActionError(undefined);
    try {
      const next = await client.confirm(confirming.id, deliveryDate);
      setDetail(next);
      setConfirming(undefined);
      toaster.show({ type: 'success', title: t('orderReviews.confirmed') });
      setChoice(next.id);
      list.reload();
    } catch (cause) {
      setActionError(errorText(cause, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section data-testid='order-review-tab' className='flex flex-col gap-4'>
      {error !== undefined ? (
        <p role='alert' className='text-sm text-destructive'>
          {errorText(error, t)}
        </p>
      ) : null}
      {access.create ? (
        <div className='flex flex-wrap items-center gap-2'>
          <Button onClick={openCreate}>{t('orderReviews.new')}</Button>
          {confirmed !== undefined ? (
            <Button variant='outline' onClick={openCreate}>
              {t('orderReviews.reReview')}
            </Button>
          ) : null}
        </div>
      ) : null}
      {actionError !== undefined && !creating && confirming === undefined ? (
        <p role='alert' className='text-sm text-destructive'>
          {actionError}
        </p>
      ) : null}

      <div className='grid gap-4 md:grid-cols-2'>
        <div data-testid='order-review-list' className='flex flex-col gap-1'>
          {loading ? <p role='status'>{t('orderReviews.loading')}</p> : null}
          {!loading && reviews.length === 0 ? (
            <p className='text-sm text-muted-foreground'>
              {t('orderReviews.empty')}
            </p>
          ) : null}
          {reviews.map((row) => (
            <Button
              key={row.id}
              type='button'
              variant={row.id === selectedId ? 'secondary' : 'outline'}
              aria-pressed={row.id === selectedId}
              aria-label={`${t('orderReviews.reviewer')}: ${row.reviewer.name}`}
              onClick={() => setChoice(row.id)}
              className='h-auto w-full justify-start whitespace-normal px-3 py-2 text-left text-sm'
            >
              <span className='flex flex-wrap items-center justify-between gap-2'>
                <span className='font-medium'>{row.reviewer.name}</span>
                <span>{t(`orderReviews.status.${row.status}`)}</span>
              </span>
              <span className='text-xs text-muted-foreground'>
                {formatDateTime(row.reviewedAt, locale)}
              </span>
            </Button>
          ))}
        </div>

        <div data-testid='order-review-detail' className='flex flex-col gap-3'>
          {selected === undefined ? (
            <p className='text-sm text-muted-foreground'>
              {t('orderReviews.empty')}
            </p>
          ) : (
            <>
              <p className='text-sm'>
                {t('orderReviews.reviewer')}: {selected.reviewer.name}
              </p>
              <p className='text-sm'>
                {t('orderReviews.reviewedAt')}:{' '}
                {formatDateTime(selected.reviewedAt, locale)}
              </p>
              <p className='text-sm'>
                {t('orderReviews.confirmedDeliveryDate')}:{' '}
                {selected.confirmedDeliveryDate ?? '—'}
              </p>
              <ul className='flex flex-col gap-2'>
                {(selected.lines ?? []).map((line, index) => (
                  <li key={`${line.factor}-${line.id ?? index}`} className='rounded-lg border border-border p-3 text-sm'>
                    <span className='font-medium'>
                      {t(`orderReviews.factor.${line.factor}`)}
                    </span>
                    <p className='whitespace-pre-wrap'>{line.conclusion}</p>
                    {line.note ? (
                      <p className='text-muted-foreground'>{line.note}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              <div className='flex flex-wrap gap-2'>
                {access.submit && selected.status === 'draft' ? (
                  <PendingButton
                    busy={busy}
                    onClick={() => void submit(selected)}
                  >
                    {t('orderReviews.submit')}
                  </PendingButton>
                ) : null}
                {access.confirm && selected.status === 'submitted' ? (
                  <Button
                    onClick={() => {
                      setActionError(undefined);
                      setDeliveryDate('');
                      setConfirming(selected);
                    }}
                  >
                    {t('orderReviews.confirm')}
                  </Button>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>

      <Dialog open={creating} onOpenChange={(open) => { if (!open && !busy) setCreating(false); }}>
        <DialogContent data-testid='order-review-create-dialog'>
          <FeedbackForm onSubmit={(event) => void create(event)}>
            <DialogHeader>
              <DialogTitle>{t('orderReviews.createTitle')}</DialogTitle>
            </DialogHeader>
            {confirmed !== undefined ? (
              <p role='note' data-testid='order-review-re-review-warning' className='text-sm text-destructive'>
                {t('orderReviews.reReviewWarning')}
              </p>
            ) : null}
            <div className='flex flex-col gap-1'>
              <Label htmlFor='order-review-reviewer'>
                {t('orderReviews.reviewer')}
              </Label>
              <Select value={reviewer || null} onValueChange={(value) => setReviewer(String(value ?? ''))}>
                <SelectTrigger id='order-review-reviewer' aria-label={t('orderReviews.reviewer')}>
                  <SelectValue placeholder={t('orderReviews.chooseReviewer')} />
                </SelectTrigger>
                <SelectContent>
                  {personChoices(people.items).map((person) => (
                    <SelectItem key={person.value} value={person.value}>
                      {person.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {REVIEW_FACTORS.map((factor) => (
              <div key={factor} className='flex flex-col gap-1'>
                <Label htmlFor={`order-review-${factor}`}>
                  {t(`orderReviews.factor.${factor}`)}
                </Label>
                <Textarea
                  id={`order-review-${factor}`}
                  aria-label={t(`orderReviews.factor.${factor}`)}
                  value={factors[factor].conclusion}
                  onChange={(event) =>
                    setFactors((old) => ({
                      ...old,
                      [factor]: { ...old[factor], conclusion: event.target.value },
                    }))
                  }
                />
                <Input
                  aria-label={t('orderReviews.note')}
                  placeholder={t('orderReviews.note')}
                  value={factors[factor].note}
                  onChange={(event) =>
                    setFactors((old) => ({
                      ...old,
                      [factor]: { ...old[factor], note: event.target.value },
                    }))
                  }
                />
              </div>
            ))}
            {actionError !== undefined ? (
              <p role='alert' className='text-sm text-destructive'>
                {actionError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type='button' variant='outline' onClick={() => setCreating(false)}>
                {t('orderReviews.cancel')}
              </Button>
              <PendingButton type='submit' busy={busy}>
                {t('orderReviews.create')}
              </PendingButton>
            </DialogFooter>
          </FeedbackForm>
        </DialogContent>
      </Dialog>

      <Dialog open={confirming !== undefined} onOpenChange={(open) => { if (!open && !busy) setConfirming(undefined); }}>
        <DialogContent data-testid='order-review-confirm-dialog'>
          <FeedbackForm onSubmit={(event) => void confirm(event)}>
            <DialogHeader>
              <DialogTitle>{t('orderReviews.confirmTitle')}</DialogTitle>
            </DialogHeader>
            <div className='flex flex-col gap-1'>
              <Label htmlFor='order-review-delivery-date'>
                {t('orderReviews.confirmedDeliveryDate')}
              </Label>
              {/* ui-component-exception: 项目尚无日期选择器与日历依赖，本片沿用订单与库存页的原生日期输入（D-056），不另造 DatePicker */}
              <Input
                id='order-review-delivery-date'
                type='date'
                aria-label={t('orderReviews.confirmedDeliveryDate')}
                value={deliveryDate}
                onChange={(event) => setDeliveryDate(event.target.value)}
              />
            </div>
            {actionError !== undefined ? (
              <p role='alert' className='text-sm text-destructive'>
                {actionError}
              </p>
            ) : null}
            <DialogFooter>
              <Button type='button' variant='outline' onClick={() => setConfirming(undefined)}>
                {t('orderReviews.cancel')}
              </Button>
              <PendingButton type='submit' busy={busy}>
                {t('orderReviews.confirmAction')}
              </PendingButton>
            </DialogFooter>
          </FeedbackForm>
        </DialogContent>
      </Dialog>
    </section>
  );
}
