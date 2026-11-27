import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';

import { Card, CardContent, CardHeader, CardTitle } from '#components/ui/card';

import type { QualityTicket } from './client.js';

/** 部门分流卡：按责任部门数一遍已加载的工单。没有部门的老数据归进「未指派」。 */
export function ByDepartmentCard({
  tickets,
}: {
  readonly tickets: readonly QualityTicket[];
}): ReactElement {
  const { t } = useTranslation();
  const byDepartment = useMemo(() => {
    const map = new Map<string, number>();
    for (const ticket of tickets) {
      // 按部门标识分组，标题跟着行走；解析不出的显示「未指派」。
      const key = ticket.departmentId ?? 'unassigned';
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return [...map.entries()].sort((a, b) => b[1] - a[1]);
  }, [tickets]);

  const titleOf = (departmentId: string): string => {
    if (departmentId === 'unassigned') return t('quality.unassigned');
    return (
      tickets.find((ticket) => ticket.departmentId === departmentId)
        ?.departmentTitle ?? departmentId
    );
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className='text-sm'>
          {t('quality.department.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className='flex flex-col gap-2'>
        {byDepartment.length === 0 ? (
          <p className='text-sm text-muted-foreground'>{t('quality.empty')}</p>
        ) : (
          byDepartment.map(([department, count]) => (
            <div
              key={department}
              className='flex items-center justify-between text-sm'
            >
              <span className='font-mono text-xs text-muted-foreground'>
                {titleOf(department)}
              </span>
              <span className='tabular-nums'>{count}</span>
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
