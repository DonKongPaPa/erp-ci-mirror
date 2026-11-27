import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute, RecordRoute } from '#components/erp/form-route';
import { useRecord } from '#components/erp/record';

import { ShiftsClient, type Shift } from './client.js';
import { ShiftFormFields, ShiftSourceNotice } from './form.js';
import {
  copyFormOf,
  inputOf,
  shiftFieldErrors,
  validateShiftForm,
} from './model.js';
import { SHIFTS_RESOURCE } from './page-id.js';

interface CopyResult {
  readonly created: Shift;
  /** 旧的没能停掉（例如它本来就已经停用）。 */
  readonly deactivated: boolean;
}

/**
 * 复制新建并停用旧的（`/shifts/:shiftId/copy`）：改时间的唯一办法。
 * 提交后先建新的、再停用旧的；后一步没成时提示「新班次已建好，旧班次没能停用」——
 * 这不算失败，对话框照样关，免得再提交一次建出两条。
 */
export default function ShiftCopyPage(): ReactElement {
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
  const title = t('shifts.form.copyTitle');
  return (
    <FormRoute title={title} pending={manage.isPending} allowed={manage.can}>
      <RecordRoute title={title} record={record}>
        {(old) => (
          <FormDialog
            key={old.id}
            title={title}
            description={t('shifts.form.copyDescription', {
              title: old.title,
              code: old.id,
            })}
            submitLabel={t('shifts.form.copySubmit')}
            initialValues={copyFormOf(old)}
            validate={(values) => validateShiftForm(values, t, true)}
            fieldErrors={shiftFieldErrors}
            save={async (values): Promise<CopyResult> => {
              const created = await client.create(inputOf(values));
              try {
                await client.deactivate(old.id);
                return { created, deactivated: true };
              } catch {
                return { created, deactivated: false };
              }
            }}
            onSuccess={({ deactivated }) =>
              toaster.show(
                deactivated
                  ? {
                      type: 'success',
                      title: t('shifts.copiedToast', { name: old.title }),
                    }
                  : { type: 'warning', title: t('shifts.copyPartialToast') },
              )
            }
          >
            {(form) => (
              <div className='flex flex-col gap-4'>
                <ShiftSourceNotice shift={old} />
                <ShiftFormFields form={form} mode='copy' />
              </div>
            )}
          </FormDialog>
        )}
      </RecordRoute>
    </FormRoute>
  );
}
