import { useTranslation } from '@nocobase/i18n/client';
import { AlertTriangle } from 'lucide-react';
import { type ReactElement } from 'react';

import { Button } from '#components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '#components/ui/card';
import { Skeleton } from '#components/ui/skeleton';

import type { QualityDraftingStats } from './client.js';

/**
 * 「代填效果」（R-002）：草稿与人工确认的对照，数据来自统计端点，页面只看不存。
 *
 * 数字是「近一年」（端点允许的最大跨度）内出的草稿，全是规则版、没有模型版数据时
 * 也如实显示：模型草稿是 0、各回落原因各一行，不空白也不报错。骨架行直接渲染
 * 真实的行标签（14 行的标签都是静态的），只有数字的位置放一块不撑高行盒的骨架
 * （`h-3` 小于文本行盒）：行里有真实文本，行盒与加载完成后的数字行完全一致，
 * 高度差为 0。不要用固定高度的块去猜行高 —— `h-5` 在运行态的 `--spacing` 标度下
 * 解析成 18px，而 `text-sm` 的行盒是 19.19px，量过（重量报告 2026-11-26）。
 *
 * 刷新失败时保留上一轮的数字，但把失败亮出来（stale 提示加重试），不把旧数字
 * 悄悄当成当前值；第一次就没读到时整卡显示读取失败，同样给重试。
 */
export function DraftingOutcomesCard({
  stats,
  error,
  onRetry,
}: {
  readonly stats?: QualityDraftingStats;
  readonly error?: string;
  readonly onRetry: () => void;
}): ReactElement {
  const { t } = useTranslation();
  // 14 行的标签是静态的，骨架态也照实渲染；数字只有读到之后才有，两个数组按下标一一对应。
  const labels: readonly string[] = [
    t('quality.drafting.total'),
    t('quality.drafting.rules'),
    t('quality.drafting.model'),
    t('quality.drafting.confirmed'),
    t('quality.drafting.categoryMatched'),
    t('quality.drafting.categoryMismatched'),
    t('quality.drafting.severityMatched'),
    t('quality.drafting.severityMismatched'),
    t('quality.drafting.redacted'),
    t('quality.screenings.degrade.model-disabled'),
    t('quality.screenings.degrade.model-not-configured'),
    t('quality.screenings.degrade.model-error'),
    t('quality.screenings.degrade.timeout'),
    t('quality.screenings.degrade.invalid-output'),
  ];
  const values: readonly number[] | undefined = stats
    ? [
        stats.total,
        stats.engines.rules,
        stats.engines.model,
        stats.confirmed,
        stats.agreement.category.matched,
        stats.agreement.category.mismatched,
        stats.agreement.severity.matched,
        stats.agreement.severity.mismatched,
        stats.redacted,
        stats.degradeReasons['model-disabled'],
        stats.degradeReasons['model-not-configured'],
        stats.degradeReasons['model-error'],
        stats.degradeReasons.timeout,
        stats.degradeReasons['invalid-output'],
      ]
    : undefined;

  return (
    <Card data-testid='drafting-stats'>
      <CardHeader>
        <CardTitle className='text-sm'>{t('quality.drafting.title')}</CardTitle>
        <CardDescription>
          {t('quality.drafting.description')}
        </CardDescription>
      </CardHeader>
      <CardContent className='flex flex-col gap-2'>
        {stats && error ? (
          <div className='flex items-center gap-2 text-xs text-(--status-warning)'>
            <AlertTriangle className='size-4 shrink-0' />
            <p className='flex-1'>{t('quality.drafting.stale')}</p>
            <Button variant='outline' size='sm' onClick={onRetry}>
              {t('quality.drafting.retry')}
            </Button>
          </div>
        ) : null}
        {values ? (
          labels.map((label, index) => (
            <div
              key={label}
              className='flex items-center justify-between text-sm'
            >
              <span className='text-muted-foreground'>{label}</span>
              <span className='tabular-nums'>{values[index]}</span>
            </div>
          ))
        ) : error ? (
          <div className='flex items-center gap-2 text-sm text-muted-foreground'>
            <p className='flex-1'>{t('quality.page.loadFailed')}</p>
            <Button variant='outline' size='sm' onClick={onRetry}>
              {t('quality.drafting.retry')}
            </Button>
          </div>
        ) : (
          // 骨架行渲染真实的行标签，只有数字的位置放骨架；`h-3` 小于文本行盒，
          // 不会把行撑高 —— 行盒来自标签文本，与加载完成后的数字行完全一致。
          labels.map((label) => (
            <div
              key={label}
              aria-hidden='true'
              className='flex items-center justify-between text-sm'
            >
              <span className='text-muted-foreground'>{label}</span>
              <Skeleton className='h-3 w-8' />
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
