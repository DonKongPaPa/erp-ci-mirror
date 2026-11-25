import { useApiClient, useSubmission, useToaster } from '@nocobase/app-client';
import { useAuthentication } from '@nocobase/app-plugin-authentication/client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useLocale, useTranslation } from '@nocobase/i18n/client';
import {
  AlertTriangle,
  Check,
  Inbox,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactElement,
} from 'react';

import { PageContainer } from '#components/page-container';
import { PageHeader } from '#components/page-header';
import { StatusBadge } from '#components/status-badge';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Input } from '#components/ui/input';
import { Skeleton } from '#components/ui/skeleton';
import { Textarea } from '#components/ui/textarea';

import {
  QualityClient,
  type QualityMessage,
  type QualityScreening,
  type QualityTicket,
} from './client.js';

type Tone = 'neutral' | 'info' | 'warning' | 'success';

function severityTone(severity: string | null): Tone {
  switch (severity) {
    case 'critical':
      return 'warning';
    case 'major':
      return 'warning';
    case 'minor':
      return 'neutral';
    default:
      return 'info';
  }
}

function outcomeTone(outcome: string): Tone {
  if (outcome === 'auto') return 'success';
  if (outcome === 'needs-review') return 'warning';
  if (outcome === 'reviewed') return 'info';
  return 'neutral';
}

function formatTime(value: string, locale: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

const FQC_RESOURCE = { type: 'composite', id: 'fqc' } as const;

/** 质量工单看板：左侧统计与投递，右侧工单列表与初筛明细。 */
export default function QualityPage(): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new QualityClient(api), [api]);
  const { session } = useAuthentication();

  // 按钮按权限显隐。等待权限结果期间 `can` 是 false，所以按钮先不显示、后出现，
  // 不会先闪一下再消失。等待期用占位顶住同样的高度，免得下面的卡片被顶下去。
  const intakeAccess = useCan({ resource: FQC_RESOURCE, action: 'intake' });
  const handleAccess = useCan({ resource: FQC_RESOURCE, action: 'handle' });
  // 投递的提交状态每身份一份，幂等键由钩子生成；scope 不与他人共享。
  const intakeSubmission = useSubmission({
    scope: `${session?.user.id}:quality:intake`,
  });

  const [tickets, setTickets] = useState<QualityTicket[]>([]);
  const [messages, setMessages] = useState<QualityMessage[]>([]);
  const [screenings, setScreenings] = useState<QualityScreening[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [draft, setDraft] = useState('');
  const [sender, setSender] = useState(() => t('quality.intake.defaultSender'));
  const [reloadToken, setReloadToken] = useState(0);

  const fetchAll = useCallback(async () => {
    const [ticketResult, messageResult, screeningResult] = await Promise.all([
      client.listTickets({ pageSize: 50 }),
      client.listMessages(),
      client.listScreenings(),
    ]);
    return {
      tickets: ticketResult.items,
      messages: messageResult.items,
      screenings: screeningResult.items,
    };
  }, [client]);

  useEffect(() => {
    let active = true;
    fetchAll().then(
      (data) => {
        if (!active) return;
        setTickets(data.tickets);
        setMessages(data.messages);
        setScreenings(data.screenings);
        setError(undefined);
        setLoading(false);
      },
      (next: unknown) => {
        if (!active) return;
        setError(next instanceof Error ? next.message : String(next));
        setLoading(false);
      },
    );
    return () => {
      active = false;
    };
  }, [fetchAll, reloadToken]);

  const refresh = useCallback(() => {
    setLoading(true);
    setReloadToken((value) => value + 1);
  }, []);

  const submit = async () => {
    const content = draft.trim();
    if (!content || intakeSubmission.submitting || intakeSubmission.pending) {
      return;
    }
    try {
      // 幂等键由 useSubmission 生成；返回 undefined 表示已有一个提交在途，
      // 忽略这次点击，不提示失败。超时会抛 SubmissionTimeoutError，钩子保留原操作
      // 供重试，页面按普通失败提示即可。
      const result = await intakeSubmission.run(
        { channel: 'wechat', senderName: sender.trim() || undefined, content },
        (idempotencyKey, _signal, snapshot) =>
          client.intake(snapshot, idempotencyKey),
      );
      if (!result) return;
      toaster.show({
        type: 'success',
        title: t('quality.intake.created', { code: result.ticket.code }),
        description: `${t(
          `quality.categories.${result.screening.category ?? 'other'}`,
          {
            defaultValue:
              result.screening.category ?? t('quality.uncategorized'),
          },
        )} / ${t(`quality.severities.${result.screening.severity ?? 'info'}`, {
          defaultValue: result.screening.severity ?? '-',
        })}`,
      });
      setDraft('');
      refresh();
    } catch (next) {
      toaster.show({
        type: 'error',
        title: t('quality.intake.failed'),
        description: next instanceof Error ? next.message : String(next),
      });
    }
  };

  const stats = useMemo(() => {
    const open = tickets.filter((ticket) => ticket.state === 'open').length;
    const critical = tickets.filter(
      (ticket) => ticket.severity === 'critical',
    ).length;
    const review = screenings.filter(
      (item) => item.outcome === 'needs-review',
    ).length;
    return { open, critical, review, total: tickets.length };
  }, [tickets, screenings]);

  const byDepartment = useMemo(() => {
    const map = new Map<string, number>();
    for (const ticket of tickets) {
      const key = ticket.ownerDepartment ?? 'unassigned';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [tickets]);

  return (
    <PageContainer>
      <PageHeader
        title={t('navigation.quality')}
        description={t('quality.page.description')}
        eyebrow={t('quality.page.eyebrow')}
        actions={
          <Button
            variant='outline'
            size='sm'
            onClick={() => void refresh()}
            disabled={loading}
          >
            <RefreshCw
              data-icon='inline-start'
              className={loading ? 'animate-spin' : undefined}
            />
            {t('quality.page.refresh')}
          </Button>
        }
      />

      {error ? (
        <Card className='border-destructive/40'>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-sm'>
              <AlertTriangle className='size-4' />
              {t('quality.page.loadFailed')}
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <div className='grid gap-4 sm:grid-cols-2 xl:grid-cols-4'>
        <StatCard label={t('quality.stats.total')} value={stats.total} />
        <StatCard
          label={t('quality.stats.open')}
          value={stats.open}
          tone='info'
        />
        <StatCard
          label={t('quality.stats.critical')}
          value={stats.critical}
          tone='warning'
        />
        <StatCard
          label={t('quality.stats.review')}
          value={stats.review}
          tone='warning'
        />
      </div>

      <div className='grid gap-4 lg:grid-cols-[minmax(0,22rem)_minmax(0,1fr)]'>
        <div className='flex flex-col gap-4'>
          {/* 四个业务角色都不持有「投递」，业务用户默认看不到这个表单。 */}
          {intakeAccess.can ? (
            <Card data-testid='intake-form' className='min-h-80'>
              <CardHeader>
                <CardTitle className='flex items-center gap-2 text-sm'>
                  <Send className='size-4' />
                  {t('quality.intake.title')}
                </CardTitle>
                <CardDescription>
                  {t('quality.intake.description')}
                </CardDescription>
              </CardHeader>
              <CardContent className='flex flex-col gap-3'>
                {intakeSubmission.pending ? (
                  <Alert
                    variant='destructive'
                    data-testid='intake-outcome-unknown'
                  >
                    <AlertTriangle className='size-4' />
                    <AlertDescription className='flex flex-col items-start gap-2'>
                      <p>{t('quality.intake.outcomeUnknown')}</p>
                      <Button
                        variant='outline'
                        size='sm'
                        onClick={() => {
                          // 钩子清掉 pending 后不会自己通知订阅者，借刷新列表再渲染
                          // 一次；列表也正是用户刚核对过的地方。
                          intakeSubmission.acknowledgeOutcome('not-committed');
                          refresh();
                        }}
                      >
                        {t('quality.intake.acknowledge')}
                      </Button>
                    </AlertDescription>
                  </Alert>
                ) : null}
                <Input
                  value={sender}
                  onChange={(event) => setSender(event.target.value)}
                  placeholder={t('quality.intake.senderPlaceholder')}
                />
                <Textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  placeholder={t('quality.intake.contentPlaceholder')}
                  rows={4}
                  className='resize-y'
                />
                <Button
                  onClick={() => void submit()}
                  disabled={
                    !draft.trim() ||
                    intakeSubmission.submitting ||
                    intakeSubmission.pending
                  }
                >
                  {intakeSubmission.submitting ? (
                    <Loader2
                      data-icon='inline-start'
                      className='animate-spin'
                    />
                  ) : (
                    <Sparkles data-icon='inline-start' />
                  )}
                  {t('quality.intake.submit')}
                </Button>
              </CardContent>
            </Card>
          ) : intakeAccess.isPending ? (
            <IntakeFormPlaceholder />
          ) : intakeAccess.error ? (
            <Alert variant='destructive' data-testid='intake-permission-error'>
              <AlertTriangle className='size-4' />
              <AlertDescription>
                {t('quality.permissionFailed')}
              </AlertDescription>
            </Alert>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className='text-sm'>
                {t('quality.department.title')}
              </CardTitle>
            </CardHeader>
            <CardContent className='flex flex-col gap-2'>
              {byDepartment.length === 0 ? (
                <p className='text-sm text-muted-foreground'>
                  {t('quality.empty')}
                </p>
              ) : (
                byDepartment.map(([department, count]) => (
                  <div
                    key={department}
                    className='flex items-center justify-between text-sm'
                  >
                    <span className='font-mono text-xs text-muted-foreground'>
                      {department}
                    </span>
                    <span className='tabular-nums'>{count}</span>
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle className='flex items-center gap-2 text-sm'>
              <Inbox className='size-4' />
              {t('quality.tickets.title')}
            </CardTitle>
            <CardDescription>
              {t('quality.tickets.count', { count: tickets.length })}
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            {loading && tickets.length === 0 ? (
              // 占位与真实列表同量级：加载时下方卡片不在视口内，数据到了也不会被
              // 一个约 5000 像素长的列表顶出去（首屏那一次 0.12 的位移）。
              <div
                data-testid='ticket-loading'
                aria-busy='true'
                className='min-h-96'
              >
                <div className='flex items-center gap-2 p-6 text-sm text-muted-foreground'>
                  <Loader2 className='size-4 animate-spin' />
                  {t('quality.loading')}
                </div>
                <div aria-hidden='true' className='divide-y divide-border'>
                  {Array.from({ length: 8 }, (_, index) => (
                    <div
                      key={index}
                      data-testid='ticket-loading-row'
                      className='flex flex-col gap-2 p-4'
                    >
                      <Skeleton className='h-5 w-2/3' />
                      <Skeleton className='h-4 w-full' />
                      <Skeleton className='h-4 w-1/2' />
                    </div>
                  ))}
                </div>
              </div>
            ) : tickets.length === 0 ? (
              <p className='p-6 text-sm text-muted-foreground'>
                {t('quality.tickets.empty')}
              </p>
            ) : (
              <ul className='divide-y divide-border'>
                {tickets.map((ticket) => (
                  <li key={ticket.id} className='flex flex-col gap-2 p-4'>
                    <div className='flex flex-wrap items-center gap-2'>
                      <span className='font-mono text-xs text-muted-foreground'>
                        {ticket.code}
                      </span>
                      <StatusBadge
                        tone={severityTone(ticket.severity)}
                        size='sm'
                      >
                        {t(`quality.severities.${ticket.severity}`, {
                          defaultValue: ticket.severity,
                        })}
                      </StatusBadge>
                      <StatusBadge tone='neutral' size='sm'>
                        {ticket.category
                          ? t(`quality.categories.${ticket.category}`, {
                              defaultValue: ticket.category,
                            })
                          : t('quality.uncategorized')}
                      </StatusBadge>
                      <span className='ml-auto text-xs text-muted-foreground'>
                        {formatTime(ticket.createdAt, locale)}
                      </span>
                    </div>
                    <p className='text-sm leading-6'>{ticket.description}</p>
                    <div className='flex flex-wrap items-center gap-3 text-xs text-muted-foreground'>
                      <span>
                        {t('quality.tickets.department', {
                          department:
                            ticket.ownerDepartment ?? t('quality.unassigned'),
                        })}
                      </span>
                      <span>
                        {t('quality.tickets.state', {
                          state: t(`quality.states.${ticket.state}`, {
                            defaultValue: ticket.state,
                          }),
                        })}
                      </span>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className='grid gap-4 lg:grid-cols-2'>
        <Card>
          <CardHeader>
            <CardTitle className='text-sm'>
              {t('quality.messages.title')}
            </CardTitle>
            <CardDescription>
              {t('quality.messages.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            <ul className='divide-y divide-border'>
              {messages.slice(0, 10).map((message) => (
                <li key={message.id} className='flex flex-col gap-1 p-4'>
                  <div className='flex items-center gap-2 text-xs text-muted-foreground'>
                    <span>
                      {message.senderName ??
                        t('quality.messages.unknownSender')}
                    </span>
                    <span>·</span>
                    <span>
                      {t(`quality.channels.${message.channel}`, {
                        defaultValue: message.channel,
                      })}
                    </span>
                    <span className='ml-auto'>
                      {formatTime(message.receivedAt, locale)}
                    </span>
                  </div>
                  <p className='text-sm leading-6'>{message.content}</p>
                </li>
              ))}
              {messages.length === 0 ? (
                <li className='p-4 text-sm text-muted-foreground'>
                  {t('quality.messages.empty')}
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className='text-sm'>
              {t('quality.screenings.title')}
            </CardTitle>
            <CardDescription>
              {t('quality.screenings.description')}
            </CardDescription>
          </CardHeader>
          <CardContent className='p-0'>
            <ul className='divide-y divide-border'>
              {screenings.slice(0, 10).map((item) => (
                <ScreeningItem
                  key={item.id}
                  item={item}
                  canHandle={handleAccess.can}
                  handlePending={handleAccess.isPending}
                  handleError={Boolean(handleAccess.error)}
                  onReviewed={refresh}
                />
              ))}
              {screenings.length === 0 ? (
                <li className='p-4 text-sm text-muted-foreground'>
                  {t('quality.screenings.empty')}
                </li>
              ) : null}
            </ul>
          </CardContent>
        </Card>
      </div>
    </PageContainer>
  );
}

/**
 * 一条初筛。按钮的显示条件是「这一行的状态可以确认」（端点算好的 `canReview`）
 * 与「调用的人有处理权限」（页面的 useCan）都为真；只做「确认」，不做改判。
 *
 * 每行一份提交状态：scope 带初筛 id，幂等键由 useSubmission 管。
 */
function ScreeningItem({
  item,
  canHandle,
  handlePending,
  handleError,
  onReviewed,
}: {
  readonly item: QualityScreening;
  readonly canHandle: boolean;
  readonly handlePending: boolean;
  readonly handleError: boolean;
  readonly onReviewed: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const { session } = useAuthentication();
  const client = useMemo(() => new QualityClient(api), [api]);
  const submission = useSubmission({
    scope: `${session?.user.id}:quality:review:${item.id}`,
  });

  const review = async () => {
    if (submission.submitting) return;
    try {
      const updated = await submission.run({ screeningId: item.id }, () =>
        client.review(item.id),
      );
      if (!updated) return;
      toaster.show({ type: 'success', title: t('quality.review.saved') });
      onReviewed();
    } catch (next) {
      toaster.show({
        type: 'error',
        title: t('quality.review.failed'),
        description: next instanceof Error ? next.message : String(next),
      });
    }
  };

  return (
    <li className='flex flex-col gap-1 p-4'>
      <div className='flex flex-wrap items-center gap-2'>
        <StatusBadge tone='neutral' size='sm'>
          {item.category
            ? t(`quality.categories.${item.category}`, {
                defaultValue: item.category,
              })
            : t('quality.uncategorized')}
        </StatusBadge>
        <StatusBadge tone={severityTone(item.severity)} size='sm'>
          {item.severity
            ? t(`quality.severities.${item.severity}`, {
                defaultValue: item.severity,
              })
            : '-'}
        </StatusBadge>
        <StatusBadge tone={outcomeTone(item.outcome)} size='sm'>
          {t(`quality.outcomes.${item.outcome}`, {
            defaultValue: item.outcome,
          })}
        </StatusBadge>
        <span className='ml-auto text-xs tabular-nums text-muted-foreground'>
          {t('quality.screenings.confidence', {
            value: Number(item.confidence ?? 0).toFixed(2),
          })}
        </span>
      </div>
      <p className='text-xs text-muted-foreground'>{item.summary}</p>
      <div className='flex flex-wrap items-center gap-2'>
        <p className='text-xs text-muted-foreground'>
          {t('quality.screenings.ownerAndModel', {
            owner: item.suggestedOwner ?? '-',
            model: item.modelName ?? '-',
          })}
        </p>
        {item.canReview && handlePending ? (
          <Skeleton
            data-slot='review-placeholder'
            className='ml-auto h-7 w-24'
          />
        ) : item.canReview && canHandle ? (
          <Button
            variant='outline'
            size='sm'
            className='ml-auto'
            onClick={() => void review()}
            disabled={submission.submitting}
          >
            {submission.submitting ? (
              <Loader2 data-icon='inline-start' className='animate-spin' />
            ) : (
              <Check data-icon='inline-start' />
            )}
            {t('quality.screenings.review')}
          </Button>
        ) : item.canReview && handleError ? (
          <span
            data-testid='review-permission-error'
            className='ml-auto text-xs text-destructive'
          >
            {t('quality.permissionFailed')}
          </span>
        ) : null}
      </div>
    </li>
  );
}

/**
 * 权限读回来之前顶住投递表单的位置与高度。
 *
 * 与真实表单用同一个 `min-h-80` 下限，并照表单的段落铺骨架；权限回来、表单换上
 * 时下面的卡片不会被顶下去。权限被拒时不渲染任何东西（业务用户看不到表单）。
 */
function IntakeFormPlaceholder(): ReactElement {
  return (
    <Card
      data-testid='intake-placeholder'
      aria-busy='true'
      className='min-h-80'
    >
      <CardHeader>
        <Skeleton className='h-5 w-32' />
        <Skeleton className='h-4 w-full' />
        <Skeleton className='h-4 w-4/5' />
      </CardHeader>
      <CardContent className='flex flex-col gap-3'>
        <Skeleton className='h-9 w-full' />
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-9 w-full' />
      </CardContent>
    </Card>
  );
}

function StatCard({
  label,
  value,
  tone = 'neutral',
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: Tone;
}): ReactElement {
  return (
    <Card>
      <CardHeader className='gap-1'>
        <CardDescription className='text-xs'>{label}</CardDescription>
        <CardTitle className='flex items-center gap-2 text-2xl tabular-nums'>
          {value}
          {tone === 'warning' && value > 0 ? (
            <AlertTriangle className='size-4 text-(--status-warning)' />
          ) : null}
        </CardTitle>
      </CardHeader>
    </Card>
  );
}
