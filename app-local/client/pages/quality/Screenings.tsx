import { useLocale, useTranslation } from '@nocobase/i18n/client';
import { Send } from 'lucide-react';
import { useState, type ReactElement } from 'react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '#components/ui/card';
import { Button } from '#components/ui/button';
import { Skeleton } from '#components/ui/skeleton';
import { StatusBadge } from '#components/status-badge';

import type { QualityScreening, QualityScreeningReview } from './client.js';
import { DispatchDialog } from './DispatchDialog.js';
import { formatTime } from './format.js';
import { outcomeTone, severityTone } from './tones.js';

/**
 * 客户端解析不出知识文档的标题，显示引用里能拿到的标识（`kb:` 后面的部分）；
 * 解析不出（引用不带前缀或前缀后为空）就原样显示。
 */
function knowledgeRefLabel(ref: string): string {
  return ref.startsWith('kb:') && ref.length > 'kb:'.length
    ? ref.slice('kb:'.length)
    : ref;
}

/** 初筛明细卡：每一行带出处与最近一次确认记录。 */
export function ScreeningsCard({
  screenings,
  canHandle,
  handlePending,
  handleError,
  dispatchedScreeningIds,
  onDispatched,
}: {
  readonly screenings: readonly QualityScreening[];
  readonly canHandle: boolean;
  readonly handlePending: boolean;
  readonly handleError: boolean;
  /** 已经派过单的草稿 id：从已加载的工单里算出来，这些行不再给派单按钮。 */
  readonly dispatchedScreeningIds: ReadonlySet<string>;
  readonly onDispatched: () => void;
}): ReactElement {
  const { t } = useTranslation();
  return (
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
              review={item.review}
              canHandle={canHandle}
              handlePending={handlePending}
              handleError={handleError}
              dispatched={dispatchedScreeningIds.has(item.id)}
              onDispatched={onDispatched}
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
  );
}

/**
 * 一条初筛。草稿只有一个动作「确认并派单」（R-003 的设计：页面上只有一个按钮），
 * 点开表单后类别、严重度、责任部门、经办人都能改；是否已经有工单由页面从
 * 已加载的工单里算，已派单的草稿不再给按钮。
 *
 * 按钮的显示条件是「调用的人有处理权限」（页面的 useCan）为真；权限没回来时
 * 用占位顶住同样的高度，权限读失败时亮在按钮的位置上。
 *
 * 出处（R-002）：这一行是「规则」还是「模型」出的，没跑模型或回落过的带着原因；
 * `knowledgeRefs` 里 `kb:` 的知识引用显示标识、`case:` 的相似案例只显示条数，
 * 不把案例的初筛标识渲染成能点开的链接（范围外的读者点了是 404）。
 * 确认之后草稿的这些值原样不动，下方追加「谁在何时确认成什么」——
 * 记录来自列表随行带的那一行，页面上不出现账号 id。
 */
function ScreeningItem({
  item,
  review,
  canHandle,
  handlePending,
  handleError,
  dispatched,
  onDispatched,
}: {
  readonly item: QualityScreening;
  /** 这一行最近一次确认的记录：列表随行带来的。 */
  readonly review?: QualityScreeningReview | null;
  readonly canHandle: boolean;
  readonly handlePending: boolean;
  readonly handleError: boolean;
  readonly dispatched: boolean;
  readonly onDispatched: () => void;
}): ReactElement {
  const { t } = useTranslation();
  const { locale } = useLocale();
  const [dispatchOpen, setDispatchOpen] = useState(false);

  const knowledgeRefs = (item.knowledgeRefs ?? []).filter((ref) =>
    ref.startsWith('kb:'),
  );
  const similarCaseCount = (item.knowledgeRefs ?? []).filter((ref) =>
    ref.startsWith('case:'),
  ).length;
  const degradeLabel = item.degradeReason
    ? t(`quality.screenings.degrade.${item.degradeReason}`, {
        defaultValue: item.degradeReason,
      })
    : null;

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
        <StatusBadge
          tone={item.engine === 'model' ? 'info' : 'neutral'}
          size='sm'
        >
          {item.engine === 'model'
            ? t('quality.screenings.engines.model')
            : t('quality.screenings.engines.rules')}
        </StatusBadge>
        {degradeLabel ? (
          <StatusBadge tone={item.degraded ? 'warning' : 'neutral'} size='sm'>
            {item.degraded
              ? t('quality.screenings.degraded', { reason: degradeLabel })
              : degradeLabel}
          </StatusBadge>
        ) : null}
        <span className='ml-auto text-xs tabular-nums text-muted-foreground'>
          {t('quality.screenings.confidence', {
            value: Number(item.confidence ?? 0).toFixed(2),
          })}
        </span>
      </div>
      <p className='text-xs text-muted-foreground'>{item.summary}</p>
      {knowledgeRefs.length > 0 || similarCaseCount > 0 ? (
        <div className='flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground'>
          {knowledgeRefs.length > 0 ? (
            <p>
              {t('quality.screenings.knowledge', {
                refs: knowledgeRefs.map(knowledgeRefLabel).join(' · '),
              })}
            </p>
          ) : null}
          {similarCaseCount > 0 ? (
            <p>
              {t('quality.screenings.similarCases', { count: similarCaseCount })}
            </p>
          ) : null}
        </div>
      ) : null}
      {review ? (
        <p data-testid='review-record' className='text-xs text-muted-foreground'>
          {t('quality.review.record', {
            actor: review.actorName,
            time: formatTime(review.createdAt, locale),
            category: t(`quality.categories.${review.category}`, {
              defaultValue: review.category,
            }),
            severity: t(`quality.severities.${review.severity}`, {
              defaultValue: review.severity,
            }),
          })}
        </p>
      ) : null}
      <div className='flex flex-wrap items-center gap-2'>
        <p className='text-xs text-muted-foreground'>
          {t('quality.screenings.ownerAndModel', {
            owner: item.suggestedOwner ?? '-',
            model: item.modelName ?? '-',
          })}
        </p>
        {canHandle && !dispatched ? (
          <Button
            variant='outline'
            size='sm'
            className='ml-auto'
            data-testid='dispatch-button'
            onClick={() => setDispatchOpen(true)}
          >
            <Send data-icon='inline-start' />
            {t('quality.screenings.reviewDispatch')}
          </Button>
        ) : !dispatched && handlePending ? (
          <Skeleton
            data-slot='review-placeholder'
            className='ml-auto h-7 w-24'
          />
        ) : !dispatched && handleError ? (
          <span
            data-testid='review-permission-error'
            className='ml-auto text-xs text-destructive'
          >
            {t('quality.permissionFailed')}
          </span>
        ) : null}
      </div>
      {dispatchOpen ? (
        <DispatchDialog
          screening={item}
          onClose={() => setDispatchOpen(false)}
          onDispatched={() => onDispatched()}
        />
      ) : null}
    </li>
  );
}
