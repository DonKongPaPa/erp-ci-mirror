import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';

import { CategoryFields } from './category-form.js';
import { ItemsClient, type Category } from './client.js';
import { useItemDictionaries } from './dictionaries.js';
import {
  categoryFieldErrors,
  categoryFormOf,
  categoryUpdateInput,
  validateCategory,
} from './model.js';
import { ITEMS_RESOURCE } from './page-id.js';

/**
 * 编辑物料分类（`/items/categories/:categoryId/edit`）：先读最新的一条，编码只读，
 * 名称与上级分类能改。
 */
export default function CategoryEditPage(): ReactElement {
  const { categoryId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const view = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  const pending = view.isPending || manage.isPending;
  const record = useRecord<Category>(
    `item-categories/${encodeURIComponent(categoryId)}`,
    view.can,
  );
  const dictionaries = useItemDictionaries(view.can, pending);
  const title = t('items.categories.editTitle');
  return (
    <FormRoute title={title} pending={pending} allowed={manage.can}>
      <RecordRoute title={title} record={record}>
        {(category) => (
          <RecordRoute title={title} record={dictionaries}>
            {(loaded) => (
              <FormDialog
                key={category.updatedAt}
                title={title}
                description={t('items.categories.editDescription', {
                  code: category.code,
                })}
                submitLabel={t('erp.actions.save')}
                initialValues={categoryFormOf(category)}
                validate={(values) => validateCategory(values, t, false)}
                fieldErrors={categoryFieldErrors}
                save={(values) =>
                  client.updateCategory(
                    category.id,
                    categoryUpdateInput(values, category),
                  )
                }
                onSuccess={(saved) =>
                  toaster.show({
                    type: 'success',
                    title: t('items.savedToast', {
                      noun: t('items.categories.noun'),
                      name: saved.name,
                    }),
                  })
                }
                size='narrow'
              >
                {(form) => (
                  <CategoryFields
                    form={form}
                    category={category}
                    dictionaries={loaded}
                  />
                )}
              </FormDialog>
            )}
          </RecordRoute>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
