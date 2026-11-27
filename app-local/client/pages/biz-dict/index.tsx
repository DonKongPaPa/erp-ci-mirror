import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { type ReactElement } from 'react';
import { Outlet, useSearchParams } from 'react-router';

import { ListPage, ListTabs, NewButton, type ListTab } from '#components/erp/list-page';
import { useListData } from '#hooks/use-list-data';

import type { DictTypeItem } from './client.js';
import { DictList } from './dict-list.js';
import { BIZ_DICT_RESOURCE } from './page-id.js';

/**
 * 业务字典页（`/biz-dict`，R-072）：九个类型一页，当前类型记在地址栏的 `type` 上。
 * 页授权只给 root；打开之后读要 bizDict.view，建改停用要 bizDict.manage，显隐按动作判断。
 */
export default function BizDictPage(): ReactElement {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const view = useCan({ resource: BIZ_DICT_RESOURCE, action: 'view' });
  const manage = useCan({ resource: BIZ_DICT_RESOURCE, action: 'manage' });
  const pending = view.isPending || manage.isPending;
  const types = useListData<{ items: readonly DictTypeItem[] }>(
    'biz-dict/types',
    { active: !pending },
  );
  const items = types.data?.items ?? [];
  const requested = params.get('type') ?? '';
  const current = items.some((item) => item.dictType === requested)
    ? requested
    : (items[0]?.dictType ?? '');

  const tabs: readonly ListTab[] = items.map((item) => ({
    key: item.dictType,
    label: item.label,
  }));
  return (
    <ListPage
      title={t('bizDict.title')}
      description={t('bizDict.description')}
      actions={
        manage.can && current ? (
          <NewButton
            to={`/biz-dict/new?type=${encodeURIComponent(current)}`}
            label={t('bizDict.actions.new')}
          />
        ) : undefined
      }
      tabs={
        <ListTabs
          items={tabs}
          value={current}
          onChange={(key) =>
            setParams(
              (old) => {
                const next = new URLSearchParams(old);
                for (const reset of ['q', 'page', 'pageSize', 'includeInactive'])
                  next.delete(reset);
                next.set('type', key);
                return next;
              },
              { replace: true },
            )
          }
        />
      }
    >
      {current ? (
        <DictList
          dictType={current}
          canView={view.can}
          canManage={manage.can}
          pending={pending}
        />
      ) : (
        <p role='status' className='text-sm text-muted-foreground'>
          {types.error ? t('erp.errors.generic', { reason: '' }) : t('status.loading')}
        </p>
      )}
      <Outlet />
    </ListPage>
  );
}
