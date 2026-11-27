import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';
import { parseInteger } from '#components/erp/time';

import { ShiftsClient, type Shift } from './client.js';
import { ShiftFormFields } from './form.js';
import { editFormOf, shiftFieldErrors, validateShiftForm } from './model.js';
import { SHIFTS_RESOURCE } from './page-id.js';

/** 编辑班次（`/shifts/:shiftId/edit`）：先读最新的一条，只有名称与排序能改。 */
export default function ShiftEditPage(): ReactElement {
  const { shiftId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new ShiftsClient(api), [api]);
  const manage = useCan({ resource: SHIFTS_RESOURCE, action: 'manage' });
  const record = useRecord<Shift>(
    `shifts/${encodeURIComponent(shiftId)}`,
    manage.can,
  );
  const title = t('shifts.form.editTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <RecordRoute title={title} record={record}>
        {(shift) => (
          <FormDialog
            key={shift.updatedAt}
            title={title}
            description={t('shifts.form.editDescription')}
            submitLabel={t('erp.actions.save')}
            initialValues={editFormOf(shift)}
            validate={(values) => validateShiftForm(values, t, false)}
            fieldErrors={shiftFieldErrors}
            save={(values) =>
              client.update(shift.id, {
                title: values.title.trim(),
                sortOrder: parseInteger(values.sortOrder) ?? 0,
              })
            }
            onSuccess={(saved) =>
              toaster.show({
                type: 'success',
                title: t('shifts.savedToast', { name: saved.title }),
              })
            }
          >
            {(form) => <ShiftFormFields form={form} mode='edit' />}
          </FormDialog>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
