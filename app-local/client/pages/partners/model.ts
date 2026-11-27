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
  /** 客户侧（下拉取值来自业务字典与人员选项）。 */
  readonly customerGroupCode: string;
  readonly salespersonUserId: string;
  /** 供应商侧。 */
  readonly supplierGroupCode: string;
  readonly buyerUserId: string;
  readonly payeeAccountNo: string;
  readonly payeeBankName: string;
  readonly payeeBankCode: string;
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
  customerGroupCode: partner.customerGroupCode ?? '',
  salespersonUserId: partner.salesperson?.userId ?? '',
  supplierGroupCode: partner.supplierGroupCode ?? '',
  buyerUserId: partner.buyer?.userId ?? '',
  payeeAccountNo: partner.payeeAccountNo ?? '',
  payeeBankName: partner.payeeBankName ?? '',
  payeeBankCode: partner.payeeBankCode ?? '',
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
  if (values.payeeBankCode.trim() && !/^[A-Za-z0-9]+$/u.test(values.payeeBankCode.trim()))
    errors.payeeBankCode = t('partners.errors.invalidBankCode');
  return errors;
}

/**
 * 新建时带上的新列：只在预选的那一侧有值时发，另一侧不猜。
 * 老客户端（没有新字段）的请求体与加片前一致。
 */
export function partnerCreateExtras(
  values: PartnerFormValues,
  customerCreate: boolean,
  supplierCreate: boolean,
) {
  return {
    ...(customerCreate && values.customerGroupCode
      ? { customerGroupCode: values.customerGroupCode }
      : {}),
    ...(customerCreate && values.salespersonUserId
      ? { salespersonUserId: values.salespersonUserId }
      : {}),
    ...(supplierCreate && values.supplierGroupCode
      ? { supplierGroupCode: values.supplierGroupCode }
      : {}),
    ...(supplierCreate && values.buyerUserId
      ? { buyerUserId: values.buyerUserId }
      : {}),
    ...(supplierCreate && values.payeeAccountNo.trim()
      ? { payeeAccountNo: values.payeeAccountNo.trim() }
      : {}),
    ...(supplierCreate && values.payeeBankName.trim()
      ? { payeeBankName: values.payeeBankName.trim() }
      : {}),
    ...(supplierCreate && values.payeeBankCode.trim()
      ? { payeeBankCode: values.payeeBankCode.trim() }
      : {}),
  };
}

/**
 * 编辑时提交的形状：老字段照旧；加片的列只有这一侧原本有值、现在被清掉时才带 null ——
 * 服务端本来按侧剥掉另一侧的键，页面也不自己补。
 */
export function partnerUpdateOf(
  values: PartnerFormValues,
  original?: Partner,
) {
  const result: Record<string, unknown> = {
    name: values.name.trim(),
    contactName: optional(values.contactName),
    phone: optional(values.phone),
    email: optional(values.email),
    address: optional(values.address),
    taxId: optional(values.taxId),
    note: optional(values.note),
  };
  const stored = original as unknown as Record<string, unknown> | undefined;
  const text = (
    key: string,
    value: string,
    storedKey: string = key,
  ): void => {
    if (value.trim()) result[key] = value.trim();
    else if (stored?.[storedKey] !== null && stored?.[storedKey] !== undefined)
      result[key] = null;
  };
  text('customerGroupCode', values.customerGroupCode);
  // 响应里人只有 `salesperson` / `buyer` 两个键，清掉时要按它们判原来有没有值。
  text('salespersonUserId', values.salespersonUserId, 'salesperson');
  text('supplierGroupCode', values.supplierGroupCode);
  text('buyerUserId', values.buyerUserId, 'buyer');
  text('payeeAccountNo', values.payeeAccountNo);
  text('payeeBankName', values.payeeBankName);
  text('payeeBankCode', values.payeeBankCode);
  return result;
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

export interface AddressFormValues {
  readonly address: string;
  readonly isDefault: boolean;
}

export const EMPTY_ADDRESS_FORM: AddressFormValues = {
  address: '',
  isDefault: false,
};

export const addressInputOf = (values: AddressFormValues) => ({
  address: values.address.trim(),
  isDefault: values.isDefault,
});

export function validateAddress(
  values: AddressFormValues,
  t: Translate,
): FieldErrors {
  return values.address.trim() ? {} : { address: t('erp.form.required') };
}
