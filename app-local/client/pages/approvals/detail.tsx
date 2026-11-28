import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { AlertTriangle } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';

import { useListData } from '#hooks/use-list-data';
import { Alert, AlertDescription } from '#components/ui/alert';
import { Button } from '#components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card';
import { Skeleton } from '#components/ui/skeleton';
import { StatusBadge } from '#components/status-badge';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '#components/ui/tabs';
import { errorText } from '#components/erp/messages';

import {
  ActionDialog,
  type ActionBody,
  type SimpleAction,
} from './ActionDialog.js';
import { CandidatePicker } from './CandidatePicker.js';
import { ApprovalsClient } from './client.js';
import { approvalDocumentTabs } from './document-tabs-registry.js';
import { SnapshotContent } from './document-tabs.js';
import { APPROVAL_RESOURCE, statusLabel, statusTone } from './model.js';
import { ApprovalTimeline } from './Timeline.js';

type Picker = 'delegate' | 'add';

/** 服务端 available 里的审批人动作名，与写端点路径同名。 */
const REVIEW_AVAILABLE = ['approve', 'reject', 'return', 'delegate', 'add-sign'] as const;

/**
 * 审批详情。两层显隐：useCan 管「功能给没给你」，详情内嵌的可用动作管
 * 「这张单现在能不能点」。审批按钮不再靠地址栏的任务 id 推断；任务 id 只用于发请求。
 * 服务端已按申请人/审批人判定行级资格，页面不做本地行级过滤。
 */
export default function ApprovalDetailPage(): ReactElement {
  const { t } = useTranslation();
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const taskId = searchParams.get('task') ?? '';
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ApprovalsClient(api), [api]);
  const submit = useCan({ resource: APPROVAL_RESOURCE, action: 'submit' });
  const review = useCan({ resource: APPROVAL_RESOURCE, action: 'review' });
  const request = useListData<{ data: import('./client.js').ApprovalDetail }>(
    `approvals/${encodeURIComponent(id)}`,
    { active: true },
  );
  const detail = request.data?.data;
  // 有业务页签的单据（请购单）不再显示通用键值快照；没有登记的仍照旧显示快照。
  const documentTabs = detail ? approvalDocumentTabs(detail.collectionName) : [];
  const showSnapshot = documentTabs.length === 0;
  const [action, setAction] = useState<SimpleAction>();
  const [picker, setPicker] = useState<Picker>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [resolvedTaskId, setResolvedTaskId] = useState('');

  const backSearch = useMemo(() => {
    const next = new URLSearchParams(searchParams);
    next.delete('task');
    next.delete('from');
    const text = next.toString();
    return text ? `?${text}` : '';
  }, [searchParams]);
  const backTo = searchParams.get('from') === 'tasks' ? '/approvals/tasks' : '/approvals/mine';
  const available = new Set(detail?.available ?? []);
  // 兼容 lifecycle 的转移名（sendBack / addSign），服务端给的是写端点同名动作。
  const hasReview = (name: (typeof REVIEW_AVAILABLE)[number] | 'addSign') =>
    available.has(name) ||
    (name === 'return' && available.has('sendBack')) ||
    (name === 'add-sign' && available.has('addSign'));
  const canReview = review.can && REVIEW_AVAILABLE.some((name) => hasReview(name));
  const canSubmit = submit.can;
  const detailId = detail?.id;
  const urlTaskMatches = detail?.records.some(
    (record) => record.id === taskId && (record.status === 'pending' || record.status === 'assigned'),
  ) ?? false;
  const reviewTaskId = urlTaskMatches ? taskId : resolvedTaskId;

  // 详情可以直接打开（通知链接未必带 task 参数）；待办端点只回本人的任务，用它定位任务。
  useEffect(() => {
    let active = true;
    if (!canReview || !detailId || urlTaskMatches) return;
    void client
      .tasks({ scope: 'pending', q: '', page: 1, pageSize: 100, sortBy: 'createdAt', sortDir: 'desc' })
      .then((page) => {
        if (active) setResolvedTaskId(page.data.find((row) => row.approvalId === detailId)?.id ?? '');
      })
      .catch(() => {
        if (active) setResolvedTaskId('');
      });
    return () => {
      active = false;
    };
  }, [canReview, client, detailId, urlTaskMatches]);

  const run = async (
    kind: SimpleAction | Picker,
    body: ActionBody & { readonly ids?: readonly string[]; readonly position?: 'before' | 'after' },
  ): Promise<void> => {
    if (!detail) return;
    setBusy(true);
    setError(undefined);
    try {
      if (kind === 'delegate' || kind === 'add') {
        if (!reviewTaskId) return;
        const ids = body.ids ?? [];
        await client.review(
          reviewTaskId,
          kind === 'delegate' ? 'delegate' : 'add-sign',
          kind === 'delegate'
            ? { toUserId: ids[0], comment: body.comment }
            : { userIds: [...ids], comment: body.comment, position: body.position ?? 'before' },
        );
      } else if (kind === 'withdraw' || kind === 'abort') {
        await client.applicant(detail.id, kind);
      } else if (kind === 'resubmit') {
        await client.resubmit(detail.id, body.data ?? {});
      } else if (reviewTaskId) {
        await client.review(reviewTaskId, kind, {
          comment: body.comment,
          ...(body.returnToNodeKey ? { returnToNodeKey: body.returnToNodeKey } : {}),
        });
      }
      setAction(undefined);
      setPicker(undefined);
      toaster.show({ type: 'success', title: t('approvals.actions.saved') });
      request.reload();
    } catch (next) {
      setError(errorText(next, t));
    } finally {
      setBusy(false);
    }
  };

  if (submit.isPending || review.isPending || (request.loading && detail === undefined)) {
    return (
      <div data-testid='approval-detail' aria-busy='true' className='flex flex-col gap-3 p-4'>
        <Skeleton className='h-6 w-1/3' />
        <Skeleton className='h-4 w-full' />
        <Skeleton className='h-4 w-2/3' />
      </div>
    );
  }

  return (
    <div data-testid='approval-detail' className='flex flex-col gap-4'>
      <div className='flex flex-wrap items-center justify-between gap-2'>
        <div className='flex flex-wrap items-center gap-2'>
          <StatusBadge tone={statusTone(detail?.status ?? '')} size='sm'>
            {detail ? statusLabel(t, detail.status) : '-'}
          </StatusBadge>
          {detail ? (
            <span className='text-sm text-muted-foreground'>
              {t('approvals.detail.round', { round: detail.currentRound })}
            </span>
          ) : null}
        </div>
        <Button nativeButton={false} render={<Link to={{ pathname: backTo, search: backSearch }} />} variant='outline' size='sm'>
          {t('approvals.detail.back')}
        </Button>
      </div>

      {error ? (
        <Alert variant='destructive' role='alert'>
          <AlertTriangle className='size-4' />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}

      {detail === undefined ? (
        <Card>
          <CardContent className='p-6 text-sm text-muted-foreground'>
            {request.error
              ? errorText(request.error, t)
              : t('approvals.detail.notFound')}
          </CardContent>
        </Card>
      ) : (
        <>
          {!canSubmit && !canReview ? (
            <p role='status' className='text-sm text-muted-foreground'>
              {t('approvals.detail.noAccess')}
            </p>
          ) : null}
          <div className='flex flex-wrap gap-2'>
            {canReview && hasReview('approve') ? (
              <Button size='sm' disabled={busy || !reviewTaskId} onClick={() => setAction('approve')}>
                {t('approvals.actions.approve')}
              </Button>
            ) : null}
            {canReview && hasReview('reject') ? (
              <Button size='sm' variant='outline' disabled={busy || !reviewTaskId} onClick={() => setAction('reject')}>
                {t('approvals.actions.reject')}
              </Button>
            ) : null}
            {canReview && hasReview('return') ? (
              <Button size='sm' variant='outline' disabled={busy || !reviewTaskId} onClick={() => setAction('return')}>
                {t('approvals.actions.return')}
              </Button>
            ) : null}
            {canReview && hasReview('delegate') ? (
              <Button size='sm' variant='outline' disabled={busy || !reviewTaskId} onClick={() => setPicker('delegate')}>
                {t('approvals.actions.delegate')}
              </Button>
            ) : null}
            {canReview && hasReview('add-sign') ? (
              <Button size='sm' variant='outline' disabled={busy || !reviewTaskId} onClick={() => setPicker('add')}>
                {t('approvals.actions.addSign')}
              </Button>
            ) : null}
            {canSubmit && available.has('submit') ? (
              <Button size='sm' variant='outline' disabled={busy} onClick={() => setAction('resubmit')}>
                {t('approvals.actions.resubmit')}
              </Button>
            ) : null}
            {canSubmit && available.has('withdraw') ? (
              <Button size='sm' variant='outline' disabled={busy} onClick={() => setAction('withdraw')}>
                {t('approvals.actions.withdraw')}
              </Button>
            ) : null}
            {canSubmit && available.has('abort') ? (
              <Button size='sm' variant='destructive' disabled={busy} onClick={() => setAction('abort')}>
                {t('approvals.actions.abort')}
              </Button>
            ) : null}
          </div>

          <Card>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>{t('approvals.detail.document')}</CardTitle>
            </CardHeader>
            <CardContent>
              <Tabs defaultValue={showSnapshot ? 'snapshot' : documentTabs[0]?.key}>
                <TabsList variant='line'>
                  {showSnapshot ? (
                    <TabsTrigger value='snapshot' className='px-3'>
                      {t('approvals.detail.snapshot')}
                    </TabsTrigger>
                  ) : null}
                  {documentTabs.map((tab) => (
                    <TabsTrigger key={tab.key} value={tab.key} className='px-3'>
                      {t(tab.titleKey)}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {showSnapshot ? (
                  <TabsContent value='snapshot'>
                    <SnapshotContent detail={detail} />
                  </TabsContent>
                ) : null}
                {documentTabs.map((tab) => (
                  <TabsContent key={tab.key} value={tab.key}>
                    {tab.render(detail)}
                  </TabsContent>
                ))}
              </Tabs>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className='pb-2'>
              <CardTitle className='text-sm'>{t('approvals.detail.timeline')}</CardTitle>
            </CardHeader>
            <CardContent>
              <ApprovalTimeline detail={detail} />
            </CardContent>
          </Card>
        </>
      )}

      {action && detail ? (
        <ActionDialog
          action={action}
          detail={detail}
          onClose={() => setAction(undefined)}
          onConfirm={(body) => void run(action, body)}
        />
      ) : null}
      {picker && reviewTaskId ? (
        <CandidatePicker
          taskId={reviewTaskId}
          type={picker}
          client={client}
          onClose={() => setPicker(undefined)}
          onConfirm={(body) => void run(picker, body)}
        />
      ) : null}
    </div>
  );
}
