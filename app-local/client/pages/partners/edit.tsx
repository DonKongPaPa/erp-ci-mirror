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

import { PartnersClient, type PartnerDetail } from './client.js';
import { PartnerFields } from './form.js';
import {
  partnerFieldErrors,
  partnerFormOf,
  partnerNoun,
  partnerUpdateOf,
  validatePartner,
} from './model.js';
import { CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE } from './page-id.js';

/** 编辑往来单位（`/partners/:partnerId/edit`）：叠在详情抽屉上的对话框，编码与类型不能改。 */
export default function PartnerEditPage(): ReactElement {
  const { partnerId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new PartnersClient(api), [api]);
  const customerView = useCan({ resource: CUSTOMERS_RESOURCE, action: 'view' });
  const supplierView = useCan({ resource: SUPPLIERS_RESOURCE, action: 'view' });
  const customerUpdate = useCan({
    resource: CUSTOMERS_RESOURCE,
    action: 'update',
  });
  const supplierUpdate = useCan({
    resource: SUPPLIERS_RESOURCE,
    action: 'update',
  });
  const pending = customerUpdate.isPending || supplierUpdate.isPending;
  const record = useRecord<PartnerDetail>(
    `partners/${encodeURIComponent(partnerId)}`,
    pending ? undefined : customerView.can || supplierView.can,
  );
  const title = t('partners.form.editTitle');
  return (
    <FormRoute
      title={title}
      pending={pending}
      allowed={customerUpdate.can || supplierUpdate.can}
    >
      <RecordRoute title={title} record={record}>
        {(partner) =>
          (partner.isCustomer && customerUpdate.can) ||
          (partner.isSupplier && supplierUpdate.can) ? (
            <FormDialog
              key={partner.updatedAt}
              title={t('partners.editKind', { kind: partnerNoun(partner, t) })}
              description={t('partners.form.editDescription', {
                code: partner.code,
              })}
              submitLabel={t('erp.actions.save')}
              initialValues={partnerFormOf(partner)}
              validate={(values) => validatePartner(values, t)}
              fieldErrors={partnerFieldErrors}
              save={(values) =>
                client.update(partner.id, partnerUpdateOf(values))
              }
              onSuccess={(saved) =>
                toaster.show({
                  type: 'success',
                  title: t('partners.savedToast', { name: saved.name }),
                })
              }
            >
              {(form) => <PartnerFields form={form} partner={partner} />}
            </FormDialog>
          ) : (
            <OverlayNote title={title}>{t('erp.form.noWrite')}</OverlayNote>
          )
        }
      </RecordRoute>
    </FormRoute>
  );
}
