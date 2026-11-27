import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';

import { WarehousesClient, type Warehouse } from './client.js';
import { WarehouseFormFields } from './form.js';
import {
  formOf,
  validateWarehouseForm,
  warehouseFieldErrors,
} from './model.js';
import { INVENTORY_RESOURCE } from './page-id.js';

/** 编辑仓库（`/warehouses/:warehouseId/edit`）：先读最新的一座，只有名称与备注能改。 */
export default function WarehouseEditPage(): ReactElement {
  const { warehouseId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new WarehousesClient(api), [api]);
  const manage = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'warehouseManage',
  });
  const record = useRecord<Warehouse>(
    `warehouses/${encodeURIComponent(warehouseId)}`,
    manage.can,
  );
  const title = t('warehouses.form.editTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <RecordRoute title={title} record={record}>
        {(warehouse) => (
          <FormDialog
            key={warehouse.updatedAt}
            title={title}
            description={t('warehouses.form.editDescription', {
              code: warehouse.code,
            })}
            submitLabel={t('erp.actions.save')}
            size='narrow'
            initialValues={formOf(warehouse)}
            validate={(values) => validateWarehouseForm(values, t, false)}
            fieldErrors={warehouseFieldErrors}
            // 短码不放进请求体：带了会被拒。
            save={(values) =>
              client.update(warehouse.id, {
                name: values.name.trim(),
                note: values.note.trim(),
              })
            }
            onSuccess={(saved) =>
              toaster.show({
                type: 'success',
                title: t('warehouses.savedToast', { name: saved.name }),
              })
            }
          >
            {(form) => <WarehouseFormFields form={form} mode='edit' />}
          </FormDialog>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
