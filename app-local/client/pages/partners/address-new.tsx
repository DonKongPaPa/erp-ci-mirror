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

import { AddressFields } from './address-form.js';
import { PartnersClient, type PartnerDetail } from './client.js';
import {
  addressInputOf,
  EMPTY_ADDRESS_FORM,
  validateAddress,
} from './model.js';
import { CUSTOMERS_RESOURCE } from './page-id.js';

/**
 * 新增交货地址（`/partners/:partnerId/addresses/new`）：叠在详情抽屉上的对话框。
 * 两条地址写端点只认 customers.update —— 采购侧、只是供应商的单位都不放行。
 */
export default function PartnerAddressNewPage(): ReactElement {
  const { partnerId = '' } = useParams();
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const client = useMemo(() => new PartnersClient(api), [api]);
  const customerView = useCan({ resource: CUSTOMERS_RESOURCE, action: 'view' });
  const customerUpdate = useCan({
    resource: CUSTOMERS_RESOURCE,
    action: 'update',
  });
  const pending = customerUpdate.isPending || customerView.isPending;
  const record = useRecord<PartnerDetail>(
    `partners/${encodeURIComponent(partnerId)}`,
    pending ? undefined : customerView.can,
  );
  const title = t('partners.address.addTitle');
  return (
    <FormRoute title={title} pending={pending} allowed={customerUpdate.can}>
      <RecordRoute title={title} record={record}>
        {(detail) =>
          !detail.isCustomer ? (
            <OverlayNote title={title}>
              {t('partners.address.notCustomer')}
            </OverlayNote>
          ) : detail.status !== 'active' ? (
            <OverlayNote title={title}>
              {t('partners.errors.inactive')}
            </OverlayNote>
          ) : (
            <FormDialog
              title={title}
              description={t('partners.address.addDescription', {
                name: detail.name,
              })}
              submitLabel={t('erp.actions.add')}
              initialValues={EMPTY_ADDRESS_FORM}
              validate={(values) => validateAddress(values, t)}
              save={(values) =>
                client.addAddress(detail.id, addressInputOf(values))
              }
              onSuccess={() =>
                toaster.show({
                  type: 'success',
                  title: t('partners.address.addedToast'),
                })
              }
            >
              {(form) => <AddressFields form={form} />}
            </FormDialog>
          )
        }
      </RecordRoute>
    </FormRoute>
  );
}
