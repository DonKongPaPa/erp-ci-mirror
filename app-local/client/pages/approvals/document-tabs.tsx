import { type ReactElement } from 'react';

import type { ApprovalDetail } from './client.js';

/** 快照只按键值显示，不解析金额、人员这些业务含义。 */
export function SnapshotContent({
  detail,
}: {
  readonly detail: ApprovalDetail;
}): ReactElement {
  const round =
    detail.rounds.find((item) => item.round === detail.currentRound) ??
    detail.rounds.at(-1);
  const snapshot = round?.snapshot ?? {};
  return (
    <dl
      data-testid='approval-snapshot'
      className='grid grid-cols-2 gap-x-4 gap-y-2 text-sm'
    >
      {Object.entries(snapshot).map(([key, value]) => (
        <div key={key} className='contents'>
          <dt className='font-medium text-muted-foreground'>{key}</dt>
          <dd className='break-words'>{textOf(value)}</dd>
        </div>
      ))}
    </dl>
  );
}

function textOf(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(textOf).join(', ');
  try {
    return JSON.stringify(value) ?? '-';
  } catch {
    return '-';
  }
}
