import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useLocation, useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, OverlayNote } from '#components/erp/form-route';

import { WarehousesClient, type Warehouse } from './client.js';
import { WarehouseFormFields } from './form.js';
import {
  formOf,
  validateWarehouseForm,
  warehouseFieldErrors,
} from './model.js';
import { INVENTORY_RESOURCE } from './page-id.js';

/**
 * 编辑仓库（`/warehouses/:warehouseId/edit`）：R-020 的契约没有仓库详情端点，
 * 表单用列表那一行的数据（由列表的「编辑」链接带过来），不再去读 `GET /api/warehouses/:id`。
 */
export default function WarehouseEditPage(): ReactElement {
  const { warehouseId = '' } = useParams();
  const location = useLocation();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new WarehousesClient(api), [api]);
  const manage = useCan({
    resource: INVENTORY_RESOURCE,
    action: 'warehouseManage',
  });
  const title = t('warehouses.form.editTitle');
  const row = (location.state as { warehouse?: Warehouse } | null)?.warehouse;
  // 只认列表带过来的那一行；直接敲地址时不猜数据，给一句回到列表的说明。
  const warehouse = row?.id === warehouseId ? row : undefined;
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      {warehouse === undefined ? (
        <OverlayNote title={title}>
          {t('warehouses.form.editFromList')}
        </OverlayNote>
      ) : (
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
    </FormRoute>
  );
}
