import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useNavigate } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';

import { ItemsClient } from './client.js';
import { useItemDictionaries } from './dictionaries.js';
import { ItemFields } from './item-form.js';
import {
  EMPTY_ITEM_FORM,
  itemCreateInput,
  itemFieldErrors,
  itemNoun,
  validateItem,
} from './model.js';
import { ITEMS_RESOURCE } from './page-id.js';

/**
 * 新建物料（`/items/new`）：编码由系统发放，对话框里不画编码。
 * 分类与基本单位从两本字典里选，字典读到之后才画表单 —— 读不到时在对话框里说明原因。
 */
export default function ItemNewPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  const purchasePrice = useCan({
    resource: ITEMS_RESOURCE,
    action: 'viewPurchasePrice',
  });
  const salesPrice = useCan({
    resource: ITEMS_RESOURCE,
    action: 'viewSalesPrice',
  });
  const dictionaries = useItemDictionaries(manage.can, manage.isPending);
  const title = t('items.form.newTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <RecordRoute title={title} record={dictionaries}>
        {(loaded) => (
          <FormDialog
            title={title}
            description={t('erp.form.codeIssued')}
            submitLabel={t('erp.actions.create')}
            initialValues={EMPTY_ITEM_FORM}
            validate={(values) => validateItem(values, t)}
            fieldErrors={itemFieldErrors}
            save={(values) => client.create(itemCreateInput(values))}
            onSuccess={(item) => {
              // 列表按编码升序，新记录的编码最大、排在最后一页；提示里带「查看」，点开就是它的详情。
              const view = (): void =>
                void navigate(`/items/${encodeURIComponent(item.id)}`);
              toaster.show({
                type: 'success',
                title: t('items.createdToast', {
                  noun: itemNoun(item.itemType, t),
                  name: item.name,
                }),
                action: { label: t('erp.actions.view'), onClick: view },
              });
            }}
          >
            {(form) => (
              <ItemFields
                form={form}
                dictionaries={loaded}
                canViewPurchasePrice={purchasePrice.can}
                canViewSalesPrice={salesPrice.can}
              />
            )}
          </FormDialog>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
