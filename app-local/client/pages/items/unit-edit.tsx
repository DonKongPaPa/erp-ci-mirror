import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';

import { ItemsClient, type Unit } from './client.js';
import {
  unitFieldErrors,
  unitFormOf,
  unitUpdateInput,
  validateUnit,
} from './model.js';
import { ITEMS_RESOURCE } from './page-id.js';
import { UnitFields } from './unit-form.js';

/** 编辑计量单位（`/items/units/:unitCode/edit`）：先读最新的一条，编码只读，名称与小数位能改。 */
export default function UnitEditPage(): ReactElement {
  const { unitCode = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ItemsClient(api), [api]);
  const view = useCan({ resource: ITEMS_RESOURCE, action: 'view' });
  const manage = useCan({ resource: ITEMS_RESOURCE, action: 'manage' });
  const record = useRecord<Unit>(
    `units/${encodeURIComponent(unitCode)}`,
    view.can,
  );
  const title = t('items.units.editTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <RecordRoute title={title} record={record}>
        {(unit) => (
          <FormDialog
            key={unit.updatedAt}
            title={title}
            description={t('items.units.editDescription', { code: unit.code })}
            submitLabel={t('erp.actions.save')}
            initialValues={unitFormOf(unit)}
            validate={(values) => validateUnit(values, t, false)}
            fieldErrors={unitFieldErrors}
            save={(values) =>
              client.updateUnit(unit.code, unitUpdateInput(values))
            }
            onSuccess={(saved) =>
              toaster.show({
                type: 'success',
                title: t('items.savedToast', {
                  noun: t('items.units.noun'),
                  name: saved.name,
                }),
              })
            }
            size='narrow'
          >
            {(form) => <UnitFields form={form} unit={unit} />}
          </FormDialog>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
