import { useTranslation } from '@nocobase/i18n/client';
import type { ReactElement } from 'react';

import { StatusBadge } from '#components/status-badge';

import type { BomStatus } from './client.js';

const TONES: Readonly<Record<BomStatus, 'success' | 'neutral'>> = {
  active: 'success',
  inactive: 'neutral',
};

/** 状态徽标：文字写明状态，颜色只是辅助。 */
export function BomStatusBadge({ status }: { readonly status: BomStatus }): ReactElement {
  const { t } = useTranslation();
  return (
    <StatusBadge size='sm' tone={TONES[status] ?? 'neutral'}>
      {t(`boms.status.${status}`)}
    </StatusBadge>
  );
}
