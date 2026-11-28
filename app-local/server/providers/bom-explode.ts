import type { Application } from '@nocobase/app-server/application';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';

import {
  bomsReaderToken,
  BomRuleError,
  brief,
  round4,
  type BomBrief,
  type BomHeader,
  type BomStore,
} from './boms.js';

/**
 * R-019 波 2：缺料查询、MRP 与成本预估共用的唯一递归实现。
 *
 * 单层只是 levels=1，多层沿 childBomId 递归，每层用同一个 asOf 按成品选版本；
 * 用量逐层累乘，不在库里存展开结果。路径上再次遇到同一张 BOM 就是环，整次失败。
 * 有已授权的价格动作时才出金额键；这里只接受调用方算好的 includeCost 布尔值。
 */
export const MAX_DEPTH = 32;

export interface ExplodeResult {
  readonly productId: string;
  readonly asOf: string;
  readonly levels: number;
  readonly root: BomBrief;
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly parentNodeId: string | null;
    readonly bomId: string;
    readonly docNo: string;
    readonly version: string;
    readonly itemId: string;
    readonly item: {
      readonly id: string;
      readonly code: string;
      readonly name: string;
      readonly spec: string | null;
      readonly unitCode: string;
    };
    readonly qtyPerUnit: number;
    readonly lossRate: number;
    readonly effectiveQty: number;
    readonly depth: number;
  }[];
  readonly totals: readonly {
    readonly itemId: string;
    readonly code: string;
    readonly name: string;
    readonly unitCode: string;
    readonly qty: number;
    readonly basePurchasePrice?: number | null;
    readonly estimatedCost?: number | null;
  }[];
  readonly cycles: readonly string[][];
}

export interface BomExploder {
  effective(productId: string, asOf: string): Promise<BomBrief>;
  explode(
    productId: string,
    asOf: string,
    levels: number,
    includeCost: boolean,
  ): Promise<ExplodeResult>;
}

export class DatabaseBomExploder implements BomExploder {
  public constructor(private readonly store: BomStore) {}

  public async effective(productId: string, asOf: string): Promise<BomBrief> {
    const header = await this.store.effective(productId, asOf);
    if (header === undefined) throw new BomRuleError('not-effective');
    return brief(header);
  }

  public async explode(
    productId: string,
    asOf: string,
    levels: number,
    includeCost: boolean,
  ): Promise<ExplodeResult> {
    const root = await this.store.effective(productId, asOf);
    if (root === undefined) throw new BomRuleError('not-effective');
    const cap = Math.min(Math.max(1, levels), MAX_DEPTH);
    type Node = ExplodeResult['nodes'][number];
    const nodes: Node[] = [];
    let serial = 0;
    const prices = new Map<string, number | null>();

    const walk = async (
      bom: BomHeader,
      parentNodeId: string | null,
      parentQty: number,
      depth: number,
      path: ReadonlySet<string>,
    ): Promise<void> => {
      if (path.has(bom.id)) throw new BomRuleError('cycle');
      if (depth > MAX_DEPTH) throw new BomRuleError('invalid-input', 'depth');
      const lines = await this.store.lines(bom.id);
      for (const line of lines) {
        const item = await this.store.item(line.itemId);
        if (item === undefined) throw new BomRuleError('item-not-found', line.itemId);
        const qtyPerUnit = Number(line.qty);
        const lossRate = Number(line.lossRate);
        const effectiveQty = round4(parentQty * qtyPerUnit * (1 + lossRate));
        serial += 1;
        const nodeId = `n${serial}`;
        nodes.push({
          nodeId,
          parentNodeId,
          bomId: bom.id,
          docNo: bom.docNo,
          version: bom.version,
          itemId: item.id,
          item: {
            id: item.id, code: item.code, name: item.name,
            spec: item.spec, unitCode: item.unitCode,
          },
          qtyPerUnit,
          lossRate,
          effectiveQty,
          depth,
        });
        if (depth >= cap || line.childBomId === null) {
          // levels 是调用方主动截断；「不设上限」时若第 33 层真有内容才是规则错误。
          if (depth >= MAX_DEPTH && cap === MAX_DEPTH && line.childBomId !== null) {
            const pointed = await this.store.header(line.childBomId);
            if (pointed?.status === 'active') {
              const child = await this.store.effective(pointed.productId, asOf);
              if (child !== undefined && (await this.store.lines(child.id)).length > 0) {
                throw new BomRuleError('invalid-input', 'depth');
              }
            }
          }
          continue;
        }
        const pointed = await this.store.header(line.childBomId);
        if (pointed === undefined) {
          throw new BomRuleError('bom-not-found', line.childBomId);
        }
        if (pointed.status !== 'active') {
          throw new BomRuleError('bom-inactive', line.childBomId);
        }
        const child = await this.store.effective(pointed.productId, asOf);
        if (child === undefined) throw new BomRuleError('not-effective');
        await walk(
          child,
          nodeId,
          effectiveQty,
          depth + 1,
          new Set([...path, bom.id]),
        );
      }
    };

    await walk(root, null, 1, 1, new Set<string>());

    const sums = new Map<string, {
      itemId: string; code: string; name: string; unitCode: string; qty: number;
    }>();
    for (const node of nodes) {
      const current = sums.get(node.itemId) ?? {
        itemId: node.itemId,
        code: node.item.code,
        name: node.item.name,
        unitCode: node.item.unitCode,
        qty: 0,
      };
      current.qty = round4(current.qty + node.effectiveQty);
      sums.set(node.itemId, current);
    }
    type Total = ExplodeResult['totals'][number];
    const totals: Total[] = [];
    for (const total of sums.values()) {
      if (!includeCost) {
        totals.push(total);
        continue;
      }
      if (!prices.has(total.itemId)) {
        const item = await this.store.item(total.itemId);
        prices.set(total.itemId, item === undefined ? null : (
          item.basePurchasePrice === null ? null : Number(item.basePurchasePrice)
        ));
      }
      const price = prices.get(total.itemId) ?? null;
      totals.push({
        ...total,
        basePurchasePrice: price,
        estimatedCost: price === null ? null : round4(total.qty * price),
      });
    }

    return {
      productId,
      asOf,
      levels: cap,
      root: brief(root),
      nodes,
      totals,
      cycles: [],
    };
  }
}

export const bomExploderToken: ServiceToken<BomExploder> =
  createServiceToken<BomExploder>('app/bom-exploder');

export default class BomExplodeProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.bom-explode';

  public override register(): void {
    this.app.container.singleton(bomExploderToken, () => {
      const store = this.app.container.resolve(bomsReaderToken);
      return new DatabaseBomExploder(store);
    });
  }
}
