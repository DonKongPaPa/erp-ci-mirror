import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute } from '#components/erp/form-route';

import { WarehousesClient } from './client.js';
import { WarehouseFormFields } from './form.js';
import {
  EMPTY_WAREHOUSE_FORM,
  inputOf,
  validateWarehouseForm,
  warehouseFieldErrors,
} from './model.js';
import { INVENTORY_RESOURCE } from './page-id.js';

/** 新建仓库（`/warehouses/new`）：路由上的窄对话框，短码由人填。 */
export default function WarehouseNewPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new WarehousesClient(api), [api]);
  const manage = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'warehouseManage',
  });
  const title = t('warehouses.form.newTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <FormDialog
        title={title}
        description={t('warehouses.form.newDescription')}
        submitLabel={t('erp.actions.create')}
        size='narrow'
        initialValues={EMPTY_WAREHOUSE_FORM}
        validate={(values) => validateWarehouseForm(values, t, true)}
        fieldErrors={warehouseFieldErrors}
        save={(values) => client.create(inputOf(values))}
        onSuccess={(warehouse) =>
          toaster.show({
            type: 'success',
            title: t('warehouses.createdToast', { name: warehouse.name }),
          })
        }
      >
        {(form) => <WarehouseFormFields form={form} mode='new' />}
      </FormDialog>
    </FormRoute>
  );
}
