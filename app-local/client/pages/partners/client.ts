import type { ApiClient } from '@nocobase/app-client';
import type { EntityPage } from '#components/erp/list-state';

export type PartnerKind = 'customer' | 'supplier';

/** R-072 的人员选项：只有账号标识、姓名与部门，没有邮箱、手机号、工号。 */
export interface PersonOption {
  readonly userId: string;
  readonly name: string | null;
  readonly departmentId: string | null;
  readonly departmentName: string | null;
}

/** 姓名徽标式的人：往来单位响应里的销售员、采购员只有这两个键。 */
export interface PartnerPerson {
  readonly userId: string;
  readonly name: string;
}

/** 一条交货地址（R-014 加片）：只停用、不删除。 */
export interface Address {
  readonly id: string;
  readonly partnerId: string;
  readonly address: string;
  readonly isDefault: boolean;
  readonly status: 'active' | 'inactive';
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 一家往来单位，与 R-014 的 `Partner` 逐列对应；响应里没有建单人标识。 */
export interface Partner {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
  readonly status: 'active' | 'inactive';
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly address: string | null;
  readonly taxId: string | null;
  readonly note: string | null;
  /** 下面这些键由服务端按侧裁：不是那一侧的单位、或调用者没有那一侧的动作时键不出现。 */
  readonly customerGroupCode?: string | null;
  readonly supplierGroupCode?: string | null;
  readonly salesperson?: PartnerPerson | null;
  readonly buyer?: PartnerPerson | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Contact {
  readonly id: string;
  readonly partnerId: string;
  readonly name: string;
  readonly title: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly isPrimary: boolean;
}

export interface PartnerDetail extends Partner {
  readonly contacts: readonly Contact[];
  /** 只有客户侧才回；默认地址在前。 */
  readonly addresses?: readonly Address[];
}

export interface CreatePartnerInput {
  readonly name: string;
  readonly isCustomer: boolean;
  readonly isSupplier: boolean;
  readonly customerGroupCode?: string | null;
  readonly supplierGroupCode?: string | null;
  readonly salespersonUserId?: string | null;
  readonly buyerUserId?: string | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
  readonly contactName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly taxId?: string | null;
  readonly note?: string | null;
}

/** 编码与类型不在里面：服务端会剥掉，值不变。空串会被拒，清空要传 null。 */
export interface UpdatePartnerInput {
  readonly name?: string;
  readonly status?: 'active' | 'inactive';
  readonly customerGroupCode?: string | null;
  readonly supplierGroupCode?: string | null;
  readonly salespersonUserId?: string | null;
  readonly buyerUserId?: string | null;
  readonly payeeAccountNo?: string | null;
  readonly payeeBankName?: string | null;
  readonly payeeBankCode?: string | null;
  readonly contactName?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly address?: string | null;
  readonly taxId?: string | null;
  readonly note?: string | null;
}

export interface ContactInput {
  readonly name: string;
  readonly title?: string | null;
  readonly phone?: string | null;
  readonly email?: string | null;
  readonly isPrimary?: boolean;
}

export interface AddressInput {
  readonly address: string;
  readonly isDefault?: boolean;
}

export interface AddressUpdateInput {
  readonly address?: string;
  readonly isDefault?: boolean;
  readonly status?: 'active' | 'inactive';
}

export interface PartnerListQuery {
  readonly kind?: PartnerKind;
  readonly q?: string;
  readonly status?: 'active' | 'inactive';
  readonly page?: number;
  readonly pageSize?: number;
}

/** R-014 的六个端点加两条交货地址写端点。端点直接回对象或一页，没有 `{ data }` 外层。 */
export class PartnersClient {
  constructor(private readonly api: ApiClient) {}

  list(query: PartnerListQuery): Promise<EntityPage<Partner>> {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') search.set(key, String(value));
    }
    return this.api.request<EntityPage<Partner>>({
      path: `partners?${search.toString()}`,
    });
  }

  get(id: string): Promise<PartnerDetail> {
    return this.api.request<PartnerDetail>({
      path: `partners/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreatePartnerInput): Promise<Partner> {
    return this.api.request<Partner>({
      path: 'partners',
      method: 'POST',
      json: input,
    });
  }

  /** 改名称、联系方式、备注；停用与启用也是它：`{ status }`。 */
  update(id: string, input: UpdatePartnerInput): Promise<Partner> {
    return this.api.request<Partner>({
      path: `partners/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  /** 加联系人要单位的 update，且单位在用。联系人只能加、不能删。 */
  addContact(id: string, input: ContactInput): Promise<Contact> {
    return this.api.request<Contact>({
      path: `partners/${encodeURIComponent(id)}/contacts`,
      method: 'POST',
      json: input,
    });
  }

  /** 勾上「设为首要联系人」后，同一家单位原来的首要联系人自动让位（服务端做）。 */
  updateContact(
    id: string,
    contactId: string,
    input: ContactInput,
  ): Promise<Contact> {
    return this.api.request<Contact>({
      path: `partners/${encodeURIComponent(id)}/contacts/${encodeURIComponent(contactId)}`,
      method: 'PATCH',
      json: input,
    });
  }

  /** 加交货地址：只认 customers.update，且单位在用；没有删除端点。 */
  addAddress(id: string, input: AddressInput): Promise<Address> {
    return this.api.request<Address>({
      path: `partners/${encodeURIComponent(id)}/addresses`,
      method: 'POST',
      json: input,
    });
  }

  /** 改地址、设默认、停用与启用都是它：`{ address }`、`{ isDefault }`、`{ status }`。 */
  updateAddress(
    id: string,
    addressId: string,
    input: AddressUpdateInput,
  ): Promise<Address> {
    return this.api.request<Address>({
      path: `partners/${encodeURIComponent(id)}/addresses/${encodeURIComponent(addressId)}`,
      method: 'PATCH',
      json: input,
    });
  }
}
