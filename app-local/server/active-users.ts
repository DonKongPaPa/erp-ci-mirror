import type { DatabaseConnection } from '@nocobase/db';

/**
 * R-003 审计 B4：部门成员表只看成员关系，不看的账号状态。
 * 指派经办人与搜同事都只认未停用、未删除的账号；这里只做这一件事，
 * 姓名、邮箱一概不取，也不把账号是否存在暴露到响应里。
 */
export async function activeIdsOf(
  connection: DatabaseConnection,
  ids: readonly string[],
): Promise<ReadonlySet<string>> {
  const unique = [...new Set(ids.filter((id) => id.length > 0))];
  if (unique.length === 0) return new Set();
  const rows = await connection.query
    .selectFrom('user')
    .select(['id'])
    .where('id', 'in', unique)
    .where('deletedAt', 'is', null)
    .where('disabledAt', 'is', null)
    .execute();
  return new Set(rows.map((row) => String(row.id)));
}

/** 部门成员与在用账号的交集；停用/删除的账号不能被指派为经办人。 */
export async function activeMemberIdsOf(
  connection: DatabaseConnection,
  memberIds: readonly string[],
): Promise<readonly string[]> {
  const active = await activeIdsOf(connection, memberIds);
  return memberIds.filter((id) => active.has(id));
}
