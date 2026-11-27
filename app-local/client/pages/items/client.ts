import type { ApiClient } from '@nocobase/app-client';
import type { EntityPage } from '#components/erp/list-state';

export type ItemStatus = 'active' | 'inactive';
export type ItemType = 'material' | 'product';

/** 一条物料，与 R-019 的 `Item` 对应。响应里另有建单人的账号 id，页面不读它，也不展开成人员信息。 */
export interface Item {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly spec: string | null;
  readonly itemType: ItemType;
  readonly categoryCode: string | null;
  readonly unitCode: string;
  readonly status: ItemStatus;
  readonly legacyCode: string | null;
  readonly englishName: string | null;
  readonly stockMin: number | null;
  readonly stockMax: number | null;
  /** 没有对应价格动作时服务端不回这两个键：是 undefined，不是 null，页面不拿空值占成 0。 */
  readonly basePurchasePrice?: number | null;
  readonly baseSalesPrice?: number | null;
  readonly barcode: string | null;
  readonly brand: string | null;
  readonly manufacturerModel: string | null;
  readonly auxUnitCode: string | null;
  readonly unitRatio: number | null;
  readonly purchaseLeadDays: number | null;
  readonly note: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Unit {
  readonly code: string;
  readonly name: string;
  /** 0–10。 */
  readonly decimals: number;
  readonly status: ItemStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface Category {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId: string | null;
  readonly sort: number;
  readonly status: ItemStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** 编码、状态、建单人与时间戳由服务端写，不在里面。空串会被清成 `null`。 */
export interface CreateItemInput {
  readonly name: string;
  readonly itemType: ItemType;
  readonly unitCode: string;
  readonly spec?: string | null;
  readonly categoryCode?: string | null;
  readonly legacyCode?: string | null;
  readonly englishName?: string | null;
  readonly stockMin?: number;
  readonly stockMax?: number;
  readonly basePurchasePrice?: number;
  readonly baseSalesPrice?: number;
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly manufacturerModel?: string | null;
  readonly auxUnitCode?: string | null;
  readonly unitRatio?: number;
  readonly purchaseLeadDays?: number;
  readonly note?: string | null;
}

/** 编码不在里面：带了服务端会拒（`ITEM_CODE_IMMUTABLE`）。`categoryCode: null` 表示清空。 */
export interface UpdateItemInput {
  readonly name?: string;
  readonly spec?: string | null;
  readonly itemType?: ItemType;
  readonly categoryCode?: string | null;
  readonly unitCode?: string;
  readonly status?: ItemStatus;
  readonly legacyCode?: string | null;
  readonly englishName?: string | null;
  readonly stockMin?: number | null;
  readonly stockMax?: number | null;
  readonly basePurchasePrice?: number | null;
  readonly baseSalesPrice?: number | null;
  readonly barcode?: string | null;
  readonly brand?: string | null;
  readonly manufacturerModel?: string | null;
  readonly auxUnitCode?: string | null;
  readonly unitRatio?: number | null;
  readonly purchaseLeadDays?: number | null;
  readonly note?: string | null;
}

export interface CreateUnitInput {
  readonly code: string;
  readonly name: string;
  readonly decimals?: number;
}

/** 编码不能改；停用与启用也是它：`{ status }`。 */
export interface UpdateUnitInput {
  readonly name?: string;
  readonly decimals?: number;
  readonly status?: ItemStatus;
}

/** `id` 由前端生成 UUID；`parentId: null` 表示根分类。 */
export interface CreateCategoryInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly parentId?: string | null;
  readonly sort?: number;
}

/** 编码不能改；`parentId: null` 表示移到根。 */
export interface UpdateCategoryInput {
  readonly name?: string;
  readonly parentId?: string | null;
  readonly sort?: number;
  readonly status?: ItemStatus;
}

export interface ItemListQuery {
  readonly q?: string;
  readonly status?: ItemStatus;
  readonly itemType?: ItemType;
  readonly categoryCode?: string;
  readonly page?: number;
  readonly pageSize?: number;
}

export interface DictionaryListQuery {
  readonly q?: string;
  readonly status?: ItemStatus;
  readonly page?: number;
  readonly pageSize?: number;
}

function searchOf(query: DictionaryListQuery): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') search.set(key, String(value));
  }
  return search.toString();
}

/** R-019 的十二个端点。端点直接回一条记录或一页，没有 `{ data }` 外层；没有删除，停用代替。 */
export class ItemsClient {
  constructor(private readonly api: ApiClient) {}

  listItems(query: ItemListQuery): Promise<EntityPage<Item>> {
    return this.api.request<EntityPage<Item>>({
      path: `items?${searchOf(query)}`,
    });
  }

  get(id: string): Promise<Item> {
    return this.api.request<Item>({
      path: `items/${encodeURIComponent(id)}`,
    });
  }

  create(input: CreateItemInput): Promise<Item> {
    return this.api.request<Item>({
      path: 'items',
      method: 'POST',
      json: input,
    });
  }

  /** 改名称、规格、分类、单位、备注；停用与启用也是它：`{ status }`。 */
  update(id: string, input: UpdateItemInput): Promise<Item> {
    return this.api.request<Item>({
      path: `items/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }

  listUnits(query: DictionaryListQuery): Promise<EntityPage<Unit>> {
    return this.api.request<EntityPage<Unit>>({
      path: `units?${searchOf(query)}`,
    });
  }

  getUnit(code: string): Promise<Unit> {
    return this.api.request<Unit>({
      path: `units/${encodeURIComponent(code)}`,
    });
  }

  createUnit(input: CreateUnitInput): Promise<Unit> {
    return this.api.request<Unit>({
      path: 'units',
      method: 'POST',
      json: input,
    });
  }

  updateUnit(code: string, input: UpdateUnitInput): Promise<Unit> {
    return this.api.request<Unit>({
      path: `units/${encodeURIComponent(code)}`,
      method: 'PATCH',
      json: input,
    });
  }

  listCategories(query: DictionaryListQuery): Promise<EntityPage<Category>> {
    return this.api.request<EntityPage<Category>>({
      path: `item-categories?${searchOf(query)}`,
    });
  }

  getCategory(id: string): Promise<Category> {
    return this.api.request<Category>({
      path: `item-categories/${encodeURIComponent(id)}`,
    });
  }

  createCategory(input: CreateCategoryInput): Promise<Category> {
    return this.api.request<Category>({
      path: 'item-categories',
      method: 'POST',
      json: input,
    });
  }

  updateCategory(id: string, input: UpdateCategoryInput): Promise<Category> {
    return this.api.request<Category>({
      path: `item-categories/${encodeURIComponent(id)}`,
      method: 'PATCH',
      json: input,
    });
  }
}
