import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { Loader2 } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Dialog, DialogContent } from '#components/ui/dialog';
import { Label } from '#components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '#components/ui/select';
import { Skeleton } from '#components/ui/skeleton';
import { StatusBadge } from '#components/status-badge';

import { QualityClient, type TicketDetail } from './client.js';
import { AssistSection } from './Assist.js';
import { ColleagueSearch } from './ColleagueSearch.js';
import { formatTime } from './format.js';
import { TICKET_DETAIL_SHELL_CLASS } from './layout.js';
import { CATEGORIES, SEVERITIES, transitionNames } from './model.js';
import { severityTone } from './tones.js';
import {
  AcceptDialog,
  CloseDialog,
  ReassignDialog,
  ReopenDialog,
  ResolveDialog,
} from './TicketActions.js';
import { ticketErrorText } from './ticket-errors.js';
import { FQC_RESOURCE } from './page-id.js';

/**
 * 工单详情：工单字段、确认记录、流转历史，以及按权限出现的动作。
 * 流转按钮只按服务端算好的 `canTransition` 显隐 —— 客户端不自己判断能不能流转；
 * 改判给持「处理」的人，改经办人与帮手给持「处理工单」的人（服务端再核一遍）。
 */
export function TicketDetailDialog({
  ticketId,
  client: providedClient,
  onClose,
  onChanged,
}: {
  readonly ticketId: string;
  readonly client?: QualityClient;
  readonly onClose: () => void;
  /** 任一动作成功之后回调：父级刷新列表（与统计）。 */
  readonly onChanged: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(
    () => providedClient ?? new QualityClient(api),
    [providedClient, api],
  );
  const ticketAccess = useCan({ resource: FQC_RESOURCE, action: 'ticket' });
  const handleAccess = useCan({ resource: FQC_RESOURCE, action: 'handle' });

  const [detail, setDetail] = useState<TicketDetail>();
  const [error, setError] = useState<string>();
  const [reloadToken, setReloadToken] = useState(0);
  const [action, setAction] = useState<
    'accept' | 'resolve' | 'close' | 'reopen' | 'reassign' | 'assignee' | 'rejudge' | undefined
  >();

  const reload = useCallback(() => {
    setReloadToken((value) => value + 1);
  }, []);

  useEffect(() => {
    let active = true;
    client.getTicket(ticketId).then(
      (next) => {
        if (active) {
          setDetail(next);
          setError(undefined);
        }
      },
      (next: unknown) => {
        if (active) setError(next instanceof Error ? next.message : String(next));
      },
    );
    return () => {
      active = false;
    };
  }, [client, reloadToken, ticketId]);

  const onActionDone = (): void => {
    toaster.show({ type: 'success', title: t('quality.transitionsSaved') });
    reload();
    onChanged();
  };

  const ticket = detail?.ticket;
  const canTransition = transitionNames(ticket?.canTransition);
  // 骨架与落定内容共用同一个外壳类：首帧就把对话框撑到落定的高度带，顶边不动。
  const shellClass = TICKET_DETAIL_SHELL_CLASS;

  return (
    <Dialog open onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent>
        {detail === undefined ? (
          <div className={shellClass} aria-busy='true' data-testid='ticket-detail-loading'>
            {error ? (
              <Alert variant='destructive' role='alert'>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : (
              <>
                <Skeleton className='h-5 w-1/2' />
                <Skeleton className='h-4 w-full' />
                <Skeleton className='h-4 w-2/3' />
                <Skeleton className='h-4 w-1/2' />
              </>
            )}
          </div>
        ) : (
          <div className={shellClass}>
            <div className='flex flex-wrap items-center gap-2'>
              <span className='font-mono text-xs text-muted-foreground'>
                {ticket?.code}
              </span>
              <StatusBadge tone='info' size='sm'>
                {t(`quality.states.${ticket?.state}`, {
                  defaultValue: ticket?.state,
                })}
              </StatusBadge>
              <StatusBadge tone={severityTone(ticket?.severity ?? null)} size='sm'>
                {t(`quality.severities.${ticket?.severity}`, {
                  defaultValue: ticket?.severity,
                })}
              </StatusBadge>
              {ticket?.category ? (
                <StatusBadge tone='neutral' size='sm'>
                  {t(`quality.categories.${ticket.category}`, {
                    defaultValue: ticket.category,
                  })}
                </StatusBadge>
              ) : null}
              <span className='ml-auto text-xs text-muted-foreground'>
                {ticket ? formatTime(ticket.createdAt, locale) : null}
              </span>
            </div>
            <h3 className='text-sm font-medium leading-6'>{ticket?.title}</h3>
            {ticket?.description ? (
              <p className='text-sm leading-6'>{ticket.description}</p>
            ) : null}
            <dl className='grid grid-cols-2 gap-x-4 gap-y-1 text-sm'>
              <Field label={t('quality.tickets.fields.department')}>
                {ticket?.departmentTitle ?? t('quality.unassigned')}
              </Field>
              <Field
                label={t('quality.tickets.assigneeLabel')}
              >
                {ticket?.assigneeName ?? t('quality.unassigned')}
              </Field>
              <Field label={t('quality.tickets.fields.created')}>
                {ticket ? formatTime(ticket.createdAt, locale) : null}
              </Field>
              <Field label={t('quality.tickets.fields.closed')}>
                {ticket?.closedAt ? formatTime(ticket.closedAt, locale) : '-'}
              </Field>
              {ticket?.reopenCount ? (
                <Field label={t('quality.tickets.fields.reopenCount')}>
                  {ticket.reopenCount}
                </Field>
              ) : null}
            </dl>
            {ticket?.resolution ? (
              <div className='flex flex-col gap-1'>
                <p className='text-xs font-medium text-muted-foreground'>
                  {t('quality.tickets.fields.resolution')}
                </p>
                <p className='text-sm leading-6'>{ticket.resolution}</p>
              </div>
            ) : null}

            <div className='flex flex-wrap items-center gap-2'>
              {canTransition.includes('accept') ? (
                <Button
                  variant='outline'
                  size='sm'
                  data-testid='transition-accept'
                  onClick={() => setAction('accept')}
                >
                  {t('quality.tickets.actions.accept')}
                </Button>
              ) : null}
              {canTransition.includes('resolve') ? (
                <Button
                  variant='outline'
                  size='sm'
                  data-testid='transition-resolve'
                  onClick={() => setAction('resolve')}
                >
                  {t('quality.tickets.actions.resolve')}
                </Button>
              ) : null}
              {canTransition.includes('close') ? (
                <Button
                  variant='outline'
                  size='sm'
                  data-testid='transition-close'
                  onClick={() => setAction('close')}
                >
                  {t('quality.tickets.actions.close')}
                </Button>
              ) : null}
              {canTransition.includes('reopen') ? (
                <Button
                  variant='outline'
                  size='sm'
                  data-testid='transition-reopen'
                  onClick={() => setAction('reopen')}
                >
                  {t('quality.tickets.actions.reopen')}
                </Button>
              ) : null}
              {canTransition.includes('reassign') ? (
                <Button
                  variant='outline'
                  size='sm'
                  data-testid='transition-reassign'
                  onClick={() => setAction('reassign')}
                >
                  {t('quality.tickets.actions.reassign')}
                </Button>
              ) : null}
              {ticketAccess.can ? (
                <Button
                  variant='outline'
                  size='sm'
                  data-testid='change-assignee'
                  onClick={() => setAction('assignee')}
                >
                  {t('quality.tickets.actions.changeAssignee')}
                </Button>
              ) : null}
              {handleAccess.can && ticket?.screeningId && ticket.state !== 'closed' ? (
                // 已关闭的工单不被改判（不变量 5）：服务端会回 409，页面先收起入口。
                <Button
                  variant='outline'
                  size='sm'
                  data-testid='rejudge'
                  className='ml-auto'
                  onClick={() => setAction('rejudge')}
                >
                  {t('quality.tickets.actions.rejudge')}
                </Button>
              ) : null}
            </div>

            <div className='grid gap-4 lg:grid-cols-2'>
              <section className='flex flex-col gap-1'>
                <h4 className='text-sm font-medium'>
                  {t('quality.tickets.reviews')}
                </h4>
                {detail.reviews.length === 0 ? (
                  <p className='text-xs text-muted-foreground'>
                    {t('quality.tickets.reviewsEmpty')}
                  </p>
                ) : (
                  <ul className='flex flex-col gap-1'>
                    {detail.reviews.map((review) => (
                      <li
                        key={review.id}
                        data-testid='ticket-review-record'
                        className='text-xs text-muted-foreground'
                      >
                        {t('quality.tickets.reviewLine', {
                          kind: t(`quality.tickets.reviewKind.${review.kind}`, {
                            defaultValue: review.kind,
                          }),
                          actor: review.actorName,
                          time: formatTime(review.createdAt, locale),
                          category: t(`quality.categories.${review.category}`, {
                            defaultValue: review.category,
                          }),
                          severity: t(`quality.severities.${review.severity}`, {
                            defaultValue: review.severity,
                          }),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
              <section className='flex flex-col gap-1'>
                <h4 className='text-sm font-medium'>
                  {t('quality.tickets.transitions')}
                </h4>
                {detail.transitions.length === 0 ? (
                  <p className='text-xs text-muted-foreground'>
                    {t('quality.tickets.transitionsEmpty')}
                  </p>
                ) : (
                  <ul className='flex flex-col gap-1'>
                    {detail.transitions.map((transition) => (
                      <li
                        key={transition.id}
                        data-testid='ticket-transition-record'
                        className='text-xs text-muted-foreground'
                      >
                        {t('quality.tickets.transitionLine', {
                          name: t(`quality.tickets.actions.${transition.name}`, {
                            defaultValue: transition.name,
                          }),
                          from: transition.fromState
                            ? t(`quality.states.${transition.fromState}`, {
                                defaultValue: transition.fromState,
                              })
                            : '-',
                          to: t(`quality.states.${transition.toState}`, {
                            defaultValue: transition.toState,
                          }),
                          actor: transition.actorName ?? '-',
                          time: formatTime(transition.createdAt, locale),
                        })}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {ticketAccess.can ? (
              <AssistSection ticketId={ticketId} client={client} />
            ) : null}

            {error ? (
              <Alert variant='destructive' role='alert'>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            ) : null}
          </div>
        )}
        {action === 'accept' && ticket ? (
          <AcceptDialog
            ticket={ticket}
            onClose={() => setAction(undefined)}
            onDone={onActionDone}
          />
        ) : null}
        {action === 'resolve' && ticket ? (
          <ResolveDialog
            ticket={ticket}
            onClose={() => setAction(undefined)}
            onDone={onActionDone}
          />
        ) : null}
        {action === 'close' && ticket ? (
          <CloseDialog
            ticket={ticket}
            onClose={() => setAction(undefined)}
            onDone={onActionDone}
          />
        ) : null}
        {action === 'reopen' && ticket ? (
          <ReopenDialog
            ticket={ticket}
            onClose={() => setAction(undefined)}
            onDone={onActionDone}
          />
        ) : null}
        {action === 'reassign' && ticket ? (
          <ReassignDialog
            ticket={ticket}
            onClose={() => setAction(undefined)}
            onDone={onActionDone}
          />
        ) : null}
        {action === 'assignee' && ticket ? (
          <AssigneeDialog
            ticket={ticket}
            onClose={() => setAction(undefined)}
            onDone={onActionDone}
          />
        ) : null}
        {action === 'rejudge' && ticket?.screeningId ? (
          <RejudgeDialog
            screeningId={ticket.screeningId}
            category={ticket.category}
            severity={ticket.severity}
            onClose={() => setAction(undefined)}
            onDone={onActionDone}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactElement {
  return (
    <div className='flex flex-col gap-0.5'>
      <dt className='text-xs text-muted-foreground'>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

/** 改经办人：只换人，不换部门；可以清空。 */
function AssigneeDialog({
  ticket,
  onClose,
  onDone,
}: {
  readonly ticket: TicketDetail['ticket'];
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new QualityClient(api), [api]);
  const [assigneeId, setAssigneeId] = useState<string | null>(
    ticket.assigneeId,
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.setAssignee(ticket.id, assigneeId);
      toaster.show({ type: 'success', title: t('quality.changeAssignee.saved') });
      onDone();
      onClose();
    } catch (next) {
      setError(ticketErrorText(next, t));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent>
        <div className='flex flex-col gap-3'>
          <h3 className='text-sm font-medium'>
            {t('quality.tickets.actions.changeAssignee')}
          </h3>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='assignee-change'>
              {t('quality.tickets.assigneeLabel')}
            </Label>
            <ColleagueSearch
              id='assignee-change'
              client={client}
              departmentId={ticket.departmentId}
              value={assigneeId}
              onPick={(candidate) => setAssigneeId(candidate?.id ?? null)}
              label={t('quality.tickets.assigneeLabel')}
            />
          </div>
          {error ? (
            <Alert variant='destructive' role='alert'>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className='flex items-center justify-end gap-2'>
            <Button variant='outline' onClick={onClose} disabled={saving}>
              {t('actions.cancel')}
            </Button>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? <Loader2 className='size-4 animate-spin' /> : null}
              {t('quality.changeAssignee.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** 改判：换类别与严重度，走确认端点的改判分支；换部门是转派的事。 */
function RejudgeDialog({
  screeningId,
  category,
  severity,
  onClose,
  onDone,
}: {
  readonly screeningId: string;
  readonly category: string | null;
  readonly severity: string;
  readonly onClose: () => void;
  readonly onDone: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new QualityClient(api), [api]);
  const [nextCategory, setNextCategory] = useState(category ?? '');
  const [nextSeverity, setNextSeverity] = useState(severity);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  const submit = async (): Promise<void> => {
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await client.review(screeningId, {
        ...(nextCategory ? { category: nextCategory } : {}),
        ...(nextSeverity ? { severity: nextSeverity } : {}),
      });
      toaster.show({ type: 'success', title: t('quality.rejudge.saved') });
      onDone();
      onClose();
    } catch (next) {
      setError(ticketErrorText(next, t));
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => (!open && !saving ? onClose() : undefined)}>
      <DialogContent>
        <div className='flex flex-col gap-3'>
          <h3 className='text-sm font-medium'>{t('quality.rejudge.title')}</h3>
          <p className='text-xs text-muted-foreground'>
            {t('quality.rejudge.description')}
          </p>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='rejudge-category'>{t('quality.dispatch.category')}</Label>
            <Select
              items={CATEGORIES.map((value) => ({
                value,
                label: t(`quality.categories.${value}`),
              }))}
              value={nextCategory}
              onValueChange={(value) => setNextCategory(value as string)}
            >
              <SelectTrigger id='rejudge-category' className='w-48'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CATEGORIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`quality.categories.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className='flex flex-col gap-1'>
            <Label htmlFor='rejudge-severity'>{t('quality.dispatch.severity')}</Label>
            <Select
              items={SEVERITIES.map((value) => ({
                value,
                label: t(`quality.severities.${value}`),
              }))}
              value={nextSeverity}
              onValueChange={(value) => setNextSeverity(value as string)}
            >
              <SelectTrigger id='rejudge-severity' className='w-48'>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((value) => (
                  <SelectItem key={value} value={value}>
                    {t(`quality.severities.${value}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <p className='text-xs text-muted-foreground'>
            {t('quality.rejudge.departmentHint')}
          </p>
          {error ? (
            <Alert variant='destructive' role='alert'>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <div className='flex items-center justify-end gap-2'>
            <Button variant='outline' onClick={onClose} disabled={saving}>
              {t('actions.cancel')}
            </Button>
            <Button onClick={() => void submit()} disabled={saving}>
              {saving ? <Loader2 className='size-4 animate-spin' /> : null}
              {t('quality.rejudge.submit')}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
