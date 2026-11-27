import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';

import { CategoryFields } from './category-form.js';
import { ItemsClient } from './client.js';
import { useItemDictionaries } from './dictionaries.js';
import {
  categoryCreateInput,
  categoryFieldErrors,
  EMPTY_CATEGORY_FORM,
  randomId,
  validateCategory,
} from './model.js';
import { ITEMS_RESOURCE } from './page-id.js';

/**
 * 新建物料分类（`/items/categories/new`）：编码由人填，建好后不能改；不选上级分类就是根分类。
 * 记录的 id 由前端生成（契约要一个 UUID）。上级分类从字典里选，字典读到之后才画表单。
 */
export default function CategoryNewPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  const dictionaries = useItemDictionaries(manage.can, manage.isPending);
  const title = t('items.categories.newTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <RecordRoute title={title} record={dictionaries}>
        {(loaded) => (
          <FormDialog
            title={title}
            submitLabel={t('erp.actions.create')}
            initialValues={EMPTY_CATEGORY_FORM}
            validate={(values) => validateCategory(values, t, true)}
            fieldErrors={categoryFieldErrors}
            save={(values) =>
              client.createCategory(categoryCreateInput(values, randomId()))
            }
            onSuccess={(category) =>
              toaster.show({
                type: 'success',
                title: t('items.createdToast', {
                  noun: t('items.categories.noun'),
                  name: category.name,
                }),
              })
            }
            size='narrow'
          >
            {(form) => <CategoryFields form={form} dictionaries={loaded} />}
          </FormDialog>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
