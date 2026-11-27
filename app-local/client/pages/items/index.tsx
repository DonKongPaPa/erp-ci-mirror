import { useTranslation } from '@nocobase/i18n/client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import type { ReactElement } from 'react';
import { Outlet, useLocation, useSearchParams } from 'react-router';

import {
  ListPage,
  ListTabs,
  NewButton,
  type ListTab,
} from '#components/erp/list-page';

import { CategoryList } from './category-list.js';
import { ItemList } from './item-list.js';
import { ITEMS_RESOURCE, type ListAccess } from './page-id.js';
import { UnitList } from './unit-list.js';

const VIEWS = ['list', 'units', 'categories'] as const;
type ItemView = (typeof VIEWS)[number];

/** 换标签就是换一组数据：搜索、页码、「含已停用」和物料清单的两个筛选都清掉，只留标签。 */
const TAB_RESET_KEYS = [
  'q',
  'page',
  'pageSize',
  'includeInactive',
  'itemType',
  'categoryCode',
] as const;

/**
 * 物料（`/items`，R-019）：物料清单、计量单位、物料分类三个标签，当前标签记在地址栏的 `view` 上；
 * 换标签时页头的主按钮也跟着换。三个标签都靠 items.view 读、items.manage 写，不另设授权。
 */
export default function ItemsPage(): ReactElement {
  const { t } = useTranslation();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const view = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  // 地址栏里的标签不认识（或没带）时，退到第一个。
  const requested = params.get('view') ?? 'list';
  const current: ItemView = (VIEWS as readonly string[]).includes(requested)
    ? (requested as ItemView)
    : 'list';
  const access: ListAccess = {
    canView: view.can,
    canManage: manage.can,
    pending: view.isPending || manage.isPending,
  };

  const tabs: readonly ListTab[] = [
    { key: 'list', label: t('items.view.list') },
    { key: 'units', label: t('items.view.units') },
    { key: 'categories', label: t('items.view.categories') },
  ];
  const [newLink, newLabel] =
    current === 'units'
      ? ['/items/units/new', t('items.units.newTitle')]
      : current === 'categories'
        ? ['/items/categories/new', t('items.categories.newTitle')]
        : ['/items/new', t('items.form.newTitle')];

  return (
    <ListPage
      title={t('items.title')}
      description={t('items.description')}
      actions={
        manage.can ? (
            <NewButton to={`${newLink}${location.search}`} label={newLabel} />
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
                for (const reset of TAB_RESET_KEYS) next.delete(reset);
                next.set('view', key);
                return next;
              },
              { replace: true },
            )
          }
        />
      }
    >
      {current === 'list' ? (
        <ItemList {...access} />
      ) : current === 'units' ? (
        <UnitList {...access} />
      ) : (
        <CategoryList {...access} />
      )}
      {/* 新建、编辑的路由对话框与详情抽屉从这里出来。 */}
      <Outlet />
    </ListPage>
  );
}
