import { ApiClientError } from '@nocobase/app-client';

import type { FieldErrors } from '#components/erp/form-dialog';
import { serverMessage, type Translate } from '#components/erp/messages';

import type { Partner, PartnerKind } from './client.js';

/** 可填可不填的文本：去掉首尾空白，空的就是 `null`（空串服务端会拒）。 */
export const optional = (text: string): string | null => {
  const value = text.trim();
  return value ? value : null;
};

export interface PartnerFormValues {
  readonly name: string;
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
  readonly contactName: string;
  readonly phone: string;
  readonly email: string;
  readonly address: string;
  readonly taxId: string;
  readonly note: string;
}

export const partnerFormOf = (partner: Partner): PartnerFormValues => ({
  name: partner.name,
  isCustomer: partner.isCustomer,
  isSupplier: partner.isSupplier,
  contactName: partner.contactName ?? '',
  phone: partner.phone ?? '',
  email: partner.email ?? '',
  address: partner.address ?? '',
  taxId: partner.taxId ?? '',
  note: partner.note ?? '',
});

/** 名称必填；类型至少勾一个。其余都可以不填。 */
export function validatePartner(
  values: PartnerFormValues,
  t: Translate,
): FieldErrors {
  const errors: Record<string, string | undefined> = {};
  if (!values.name.trim()) errors.name = t('erp.form.required');
  if (!values.isCustomer && !values.isSupplier)
    errors.kinds = t('partners.errors.kindRequired');
  return errors;
}

/** 编辑时提交的形状：可改的字段全带上，清空的传 `null`。编码与类型不在里面。 */
export function partnerUpdateOf(values: PartnerFormValues) {
  return {
    name: values.name.trim(),
    contactName: optional(values.contactName),
    phone: optional(values.phone),
    email: optional(values.email),
    address: optional(values.address),
    taxId: optional(values.taxId),
    note: optional(values.note),
  };
}

/** 服务端的规则码落到哪一项下面；提示用服务端翻好的那句话。 */
export function partnerFieldErrors(error: unknown): FieldErrors {
  if (!(error instanceof ApiClientError)) return {};
  switch (error.reason) {
    case 'PARTNER_INVALID_NAME':
      return { name: serverMessage(error) };
    case 'PARTNER_KIND_REQUIRED':
      return { kinds: serverMessage(error) };
    default:
      return {};
  }
}

/** 这家单位属于哪种：既是客户又是供应商时按「往来单位」叫。 */
export function partnerNoun(
  partner: Pick<Partner, 'isCustomer' | 'isSupplier'>,
  t: Translate,
): string {
  if (partner.isCustomer && partner.isSupplier) return t('partners.noun.both');
  return partner.isCustomer
    ? t('partners.noun.customer')
    : t('partners.noun.supplier');
}

export const kindNoun = (kind: PartnerKind, t: Translate): string =>
  kind === 'customer'
    ? t('partners.noun.customer')
    : t('partners.noun.supplier');

export interface ContactFormValues {
  readonly name: string;
  readonly title: string;
  readonly phone: string;
  readonly email: string;
  readonly isPrimary: boolean;
}

export const EMPTY_CONTACT_FORM: ContactFormValues = {
  name: '',
  title: '',
  phone: '',
  email: '',
  isPrimary: false,
};

export function contactInputOf(values: ContactFormValues) {
  return {
    name: values.name.trim(),
    title: optional(values.title),
    phone: optional(values.phone),
    email: optional(values.email),
    isPrimary: values.isPrimary,
  };
}

export function validateContact(
  values: ContactFormValues,
  t: Translate,
): FieldErrors {
  return values.name.trim() ? {} : { name: t('erp.form.required') };
}
