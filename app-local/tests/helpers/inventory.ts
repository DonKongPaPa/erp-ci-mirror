import type { DatabaseConnection } from '@nocobase/db';
import { randomUUID } from 'node:crypto';

/** R-020：测试用的物料直接写进 main 的 items 表（无需走物料端点）。 */
export async function createItem(
  connection: DatabaseConnection,
  status = 'active',
): Promise<string> {
  const id = `item-${randomUUID()}`;
  const code = `T${randomUUID().replaceAll('-', '').slice(0, 10).toUpperCase()}`;
  const now = new Date();
  await connection.query
    .insertInto('items')
    .values({
      id,
      code,
      name: '测试物料',
      itemType: 'product',
      unitCode: 'PCS',
      status,
      createdById: 'inventory-test',
      createdAt: now,
      updatedAt: now,
    })
    .execute();
  return id;
}
