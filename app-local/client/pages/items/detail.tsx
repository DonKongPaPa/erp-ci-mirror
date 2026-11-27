import { useApiClient } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { Link, Outlet, useParams } from 'react-router';

import {
  ActiveBadge,
  DetailFields,
  DetailSection,
  RecordDrawer,
  TypeBadge,
} from '#components/erp/detail';
import { RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';
import { Button } from '#components/ui/button';

import { ItemsClient, type Item } from './client.js';
import {
  categoryLabel,
  unitLabel,
  useItemDictionaries,
} from './dictionaries.js';
import { itemTypeLabel } from './model.js';
import { ITEMS_RESOURCE } from './page-id.js';
import { useStatusChange } from './status-change.js';

/**
 * 物料的详情抽屉（`/items/:itemId`）：最上面是名称、类型与状态徽标，正文是「标签 — 值」，
 * 页脚是这条物料的停用（启用）与编辑。编辑是在抽屉上再叠一个对话框。
 */
export default function ItemDetailPage(): ReactElement {
  const { itemId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const view = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  const purchasePrice = useCan({
    resource: ITEMS_RESOURCE,
    action: 'viewPurchasePrice',
  });
  const salesPrice = useCan({
    resource: ITEMS_RESOURCE,
    action: 'viewSalesPrice',
  });
  const pending =
    view.isPending || manage.isPending || purchasePrice.isPending || salesPrice.isPending;
  const record = useRecord<Item>(
    `items/${encodeURIComponent(itemId)}`,
    view.can,
  );
  const dictionaries = useItemDictionaries(view.can, pending);
  return (
    <>
      {/* 编辑的路由对话框叠在抽屉上，从这个出口出来；直接敲它的地址时抽屉还在读，也要先有这个出口。 */}
      <Outlet />
      <RecordRoute title={t('items.detailTitle')} record={record} drawer>
        {(item) => (
          <ItemDrawer
            item={item}
            client={client}
            reload={record.reload}
            canManage={manage.can}
            canViewPurchasePrice={purchasePrice.can}
            canViewSalesPrice={salesPrice.can}
            // 字典只是把编码换成名字：还没读到或读不到时照常显示这一条，编码照写。
            unit={
              dictionaries.data
                ? unitLabel(dictionaries.data, item.unitCode, t)
                : item.unitCode
            }
            category={
              dictionaries.data
                ? categoryLabel(dictionaries.data, item.categoryCode, t)
                : item.categoryCode
            }
          />
        )}
      </RecordRoute>
    </>
  );
}

function ItemDrawer({
  item,
  client,
  reload,
  canManage,
  canViewPurchasePrice,
  canViewSalesPrice,
  unit,
  category,
}: {
  readonly item: Item;
  readonly client: ItemsClient;
  readonly reload: () => void;
  readonly canManage: boolean;
  readonly canViewPurchasePrice: boolean;
  readonly canViewSalesPrice: boolean;
  readonly unit: string;
  readonly category: string | null;
}): ReactElement {
  const { t } = useTranslation();
  const base = `/items/${encodeURIComponent(item.id)}`;
  const active = item.status === 'active';
  const { dialog, ask, activate } = useStatusChange<Item>({
    change: (_, status) => client.update(item.id, { status }),
    nameOf: (record) => record.name,
    noun: t('items.noun.item'),
    description: t('items.deactivateDescription'),
    reload,
  });
  return (
    <RecordDrawer
      title={item.name}
      badges={
        <>
          <TypeBadge>{itemTypeLabel(item.itemType, t)}</TypeBadge>
          <ActiveBadge active={active} />
        </>
      }
      description={t('items.codeLabel', { code: item.code })}
      footer={
        canManage ? (
          <>
            <Button
              variant='outline'
              onClick={() => (active ? ask(item) : activate(item))}
            >
              {active ? t('erp.actions.deactivate') : t('erp.actions.activate')}
            </Button>
            {/* 已停用的物料要先启用才能改：那一会儿不画编辑。 */}
            {active ? (
              <Button
                nativeButton={false}
                render={<Link to={`${base}/edit`} />}
              >
                {t('erp.actions.edit')}
              </Button>
            ) : null}
          </>
        ) : undefined
      }
    >
      <DetailSection title={t('erp.detail.basic')}>
        <DetailFields
          fields={[
            { label: t('erp.fields.name'), value: item.name },
            { label: t('erp.fields.code'), value: item.code },
            {
              label: t('erp.fields.type'),
              value: itemTypeLabel(item.itemType, t),
            },
            {
              label: t('erp.fields.status'),
              value: active ? t('erp.status.active') : t('erp.status.inactive'),
            },
            { label: t('items.columns.spec'), value: item.spec },
            { label: t('items.columns.category'), value: category },
            { label: t('items.columns.unit'), value: unit },
            { label: t('items.columns.legacyCode'), value: item.legacyCode },
            { label: t('items.columns.englishName'), value: item.englishName },
            { label: t('items.columns.stockMin'), value: item.stockMin },
            { label: t('items.columns.stockMax'), value: item.stockMax },
            ...(canViewPurchasePrice
              ? [
                  {
                    label: t('items.columns.basePurchasePrice'),
                    value: item.basePurchasePrice,
                  },
                ]
              : []),
            ...(canViewSalesPrice
              ? [
                  {
                    label: t('items.columns.baseSalesPrice'),
                    value: item.baseSalesPrice,
                  },
                ]
              : []),
            { label: t('items.columns.barcode'), value: item.barcode },
            { label: t('items.columns.brand'), value: item.brand },
            {
              label: t('items.columns.manufacturerModel'),
              value: item.manufacturerModel,
            },
            { label: t('items.columns.auxUnit'), value: item.auxUnitCode },
            { label: t('items.columns.unitRatio'), value: item.unitRatio },
            {
              label: t('items.columns.purchaseLeadDays'),
              value: item.purchaseLeadDays,
            },
            { label: t('erp.fields.note'), value: item.note, wide: true },
          ]}
        />
      </DetailSection>
      {dialog}
    </RecordDrawer>
  );
}
