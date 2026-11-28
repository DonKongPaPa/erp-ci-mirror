import type { Knex } from 'knex';

/**
 * R-021/R-022：库存过账后的订单进度回写。
 *
 * 由 R-020 的过账服务在自己的事务里调用一次；这里所有语句都用传入的 knex（事务连接），
 * 所以订单行、订单状态与库存的现存量/流水同生共死。库存单据行没有 sourceLineId
 * （已执行的迁移不改），按 itemId 对应到订单行；同一订单内 itemId 唯一由订单写服务守。
 * 回写数量取「该订单已过账单据」按物料的合计，不是增量：重复读、作废单据都不会算错。
 */
export interface PostedDocSource {
  readonly source_type: string | null;
  readonly source_id: string | null;
}

const KINDS = {
  purchase_order: {
    header: 'purchase_orders',
    lines: 'purchase_order_lines',
    progress: 'received_qty',
    complete: 'received',
    partial: 'partially_received',
  },
  sales_order: {
    header: 'sales_orders',
    lines: 'sales_order_lines',
    progress: 'shipped_qty',
    complete: 'shipped',
    partial: 'partially_shipped',
  },
} as const;

interface LineRow {
  id: string;
  item_id: string;
  qty: string | number;
}
interface TotalRow {
  item_id: string;
  qty: string | number;
}

/**
 * 带回写结果的库存单据调用它；没有来源或来源不是订单时什么也不做（普通入库/出库）。
 */
export async function syncOrderProgress(
  knex: Knex,
  doc: PostedDocSource,
): Promise<void> {
  const sourceType = doc.source_type;
  if (sourceType !== 'purchase_order' && sourceType !== 'sales_order') return;
  const sourceId = doc.source_id;
  if (sourceId === null || sourceId === '') return;
  const kind = KINDS[sourceType];

  // 锁单据头：两张关联单据同时过账时，回写串行，状态不会互相覆盖。
  const locked = await knex.raw<{ rows?: readonly { status: string }[] }>(
    `select status from ${kind.header} where id = ? for update`,
    [sourceId],
  );
  const header = locked.rows?.[0];
  if (header === undefined || header.status === 'cancelled') return;

  // R-020 波 2：退货生成的单据带 returnDocId，按物料求和时取负号冲减；作废的退货不算。
  // 仍是重算而不是拿退货数量去减当前值，重复回写不会漂。
  const totals = await knex.raw<{ rows?: readonly TotalRow[] }>(
    `select l.item_id,
            sum(case when d.return_doc_id is null then l.qty else -l.qty end) as qty
       from stock_doc_lines l
       join stock_docs d on d.id = l.doc_id
       left join return_docs r on r.id = d.return_doc_id
      where d.source_type = ? and d.source_id = ? and d.status = 'posted'
        and (d.return_doc_id is null or r.status <> 'void')
      group by l.item_id`,
    [sourceType, sourceId],
  );
  const byItem = new Map(
    (totals.rows ?? []).map((row) => [row.item_id, Number(row.qty)]),
  );

  const lines = await knex.raw<{ rows?: readonly LineRow[] }>(
    `select id, item_id, qty from ${kind.lines} where order_id = ? order by id asc for update`,
    [sourceId],
  );
  const typedLines = lines.rows ?? [];
  let touched = 0;
  for (const line of typedLines) {
    const done = byItem.get(line.item_id) ?? 0;
    await knex(kind.lines).where({ id: line.id }).update({ [kind.progress]: done });
    if (Number(done) > 0) touched += 1;
  }
  const complete = typedLines.length > 0 && typedLines.every((line) => {
    const done = byItem.get(line.item_id) ?? 0;
    return Number(done) >= Number(line.qty);
  });
  const status = complete ? kind.complete : touched > 0 ? kind.partial : 'ordered';
  await knex(kind.header)
    .where({ id: sourceId })
    .update({ status, updated_at: new Date() });
}
