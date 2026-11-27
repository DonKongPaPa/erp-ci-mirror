import { useApiClient, useToaster } from '@nocobase/app-client';
import { useCan } from '@nocobase/app-plugin-authorization/client';
import { useTranslation } from '@nocobase/i18n/client';
import { useMemo, type ReactElement } from 'react';
import { useNavigate, useSearchParams } from 'react-router';

import { FormDialog } from '#components/erp/form-dialog';
import { FormRoute } from '#components/erp/form-route';

import { PartnersClient, type PartnerKind } from './client.js';
import { PartnerFields } from './form.js';
import {
  kindNoun,
  optional,
  partnerFieldErrors,
  partnerNoun,
  validatePartner,
} from './model.js';
import { CUSTOMERS_RESOURCE, SUPPLIERS_RESOURCE } from './page-id.js';

/**
 * 新建客户或供应商（`/partners/new?kind=customer|supplier`）。类型是两个勾选框，按所在的标签预选一个；
 * 没有另一种的创建权限时，那一个勾选框不画。编码由系统发放，创建后不能修改。
 */
export default function PartnerNewPage(): ReactElement {
  const { t } = useTranslation();
  const api = useApiClient();
  const toaster = useToaster();
  const navigate = useNavigate();
  const client = useMemo(() => new PartnersClient(api), [api]);
  const [params] = useSearchParams();
  const kind: PartnerKind =
    params.get('kind') === 'supplier' ? 'supplier' : 'customer';
  const customerCreate = useCan({
    resource: CUSTOMERS_RESOURCE,
    action: 'create',
  });
  const supplierCreate = useCan({
    resource: SUPPLIERS_RESOURCE,
    action: 'create',
  });
  const pending = customerCreate.isPending || supplierCreate.isPending;
  // 地址栏让预选的那一种正好是建不了的：退到建得了的另一种。
  const preferred: PartnerKind | undefined =
    kind === 'supplier'
      ? supplierCreate.can
        ? 'supplier'
        : customerCreate.can
          ? 'customer'
          : undefined
      : customerCreate.can
        ? 'customer'
        : supplierCreate.can
          ? 'supplier'
          : undefined;
  const title = t('partners.newKind', { kind: kindNoun(preferred ?? kind, t) });
  return (
    <FormRoute
      title={title}
      pending={pending}
      allowed={customerCreate.can || supplierCreate.can}
    >
      <FormDialog
        title={title}
        description={t('erp.form.codeIssued')}
        submitLabel={t('erp.actions.create')}
        initialValues={{
          name: '',
          isCustomer: preferred === 'customer',
          isSupplier: preferred === 'supplier',
          contactName: '',
          phone: '',
          email: '',
          address: '',
          taxId: '',
          note: '',
        }}
        validate={(values) => validatePartner(values, t)}
        fieldErrors={partnerFieldErrors}
        save={(values) =>
          client.create({
            name: values.name.trim(),
            isCustomer: customerCreate.can && values.isCustomer,
            isSupplier: supplierCreate.can && values.isSupplier,
            contactName: optional(values.contactName),
            phone: optional(values.phone),
            email: optional(values.email),
            address: optional(values.address),
            taxId: optional(values.taxId),
            note: optional(values.note),
          })
        }
        onSuccess={(partner) => {
          // 列表按编码升序，新记录的编码最大、排在最后一页；提示里带「查看」，点开就是它的详情。
          const view = (): void =>
            void navigate(`/partners/${encodeURIComponent(partner.id)}`);
          toaster.show({
            type: 'success',
            title: t('partners.createdToast', {
              kind: partnerNoun(partner, t),
              name: partner.name,
            }),
            action: { label: t('erp.actions.view'), onClick: view },
          });
        }}
      >
        {(form) => (
          <PartnerFields
            form={form}
            customerCreate={customerCreate.can}
            supplierCreate={supplierCreate.can}
          />
        )}
      </FormDialog>
    </FormRoute>
  );
}
