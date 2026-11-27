import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import {
  FormRoute,
  OverlayNote,
  RecordRoute,
} from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';

import { ItemsClient, type Item } from './client.js';
import { useItemDictionaries } from './dictionaries.js';
import { ItemFields } from './item-form.js';
import {
  itemFieldErrors,
  itemFormOf,
  itemInput,
  itemNoun,
  validateItem,
} from './model.js';
import { ITEMS_RESOURCE } from './page-id.js';

/**
 * 编辑物料（`/items/:itemId/edit`）：先读最新的一条，编码只读。
 * 已停用的物料只能先启用才能改其它字段（契约的不变量 5）：直接敲这个地址时说明一句，不给表单。
 */
export default function ItemEditPage(): ReactElement {
  const { itemId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const view = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  const pending = view.isPending || manage.isPending;
  const record = useRecord<Item>(
    `items/${encodeURIComponent(itemId)}`,
    view.can,
  );
  const dictionaries = useItemDictionaries(view.can, pending);
  const title = t('items.form.editTitle');
  return (
    <FormRoute title={title} pending={pending} allowed={manage.can}>
      <RecordRoute title={title} record={record}>
        {(item) =>
          item.status === 'inactive' ? (
            <OverlayNote title={title}>{t('items.form.inactive')}</OverlayNote>
          ) : (
            <RecordRoute title={title} record={dictionaries}>
              {(loaded) => (
                <FormDialog
                  key={item.updatedAt}
                  title={title}
                  description={t('items.form.editDescription', {
                    code: item.code,
                  })}
                  submitLabel={t('erp.actions.save')}
                  initialValues={itemFormOf(item)}
                  validate={(values) => validateItem(values, t)}
                  fieldErrors={itemFieldErrors}
                  save={(values) => client.update(item.id, itemInput(values))}
                  onSuccess={(saved) =>
                    toaster.show({
                      type: 'success',
                      title: t('items.savedToast', {
                        noun: itemNoun(saved.itemType, t),
                        name: saved.name,
                      }),
                    })
                  }
                >
                  {(form) => (
                    <ItemFields form={form} item={item} dictionaries={loaded} />
                  )}
                </FormDialog>
              )}
            </RecordRoute>
          )
        }
      </RecordRoute>
    </FormRoute>
  );
}
