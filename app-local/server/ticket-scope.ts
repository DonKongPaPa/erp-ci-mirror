import type {
  Authorization,
  AuthorizationDecision,
  CompositeResourceConditions,
} from '@nocobase/authorization/core';

/**
 * R-003 S4：把一次「处理工单」授权决策解析成责任部门集合。
 *
 * 数据范围只对「查记录」生效，所以 `ticket-candidates` 的目标部门与转派的目标部门
 * 都要显式比对这里解析出来的集合，不能指望范围键自动挡住。两处共用这一个判断，
 * 各自选自己的错误码（见 R-003「为什么搜同事与转派要显式校验目标部门」）。
 *
 * 只认两种形状：
 * - `read === true` 或 `read === {scope: true, fields, relations}` → 全部部门；
 *   后者是授权插件对 `allRecords` 的真实渲染（`app-plugin-authorization` 的
 *   `dist/server/database/api.js:65-85`），seed 给质量角色的就是这个形状。
 * - `read.scope.root` 是 `departmentId $eq <id>`，或它们是 `or` 组（框架没有 `$in`，
 *   多部门展开成等值条件的或；单个条件会被 `scopeAst` 包进一个 `and` 组）。
 *
 * `false`、`{scope: false}`、`$in`/`$ne`、别的字段与别的 AST 形状一律解析不出来，
 * 返回 null，调用方拒绝。`{scope: true}` 与裸 `true` 等价是主会话 2026-11-26 的裁决：
 * 设计第三轮把它当「别的形状」是照 `read === true` 推的，与插件实际输出不符。
 */
export type TicketScope =
  | { readonly kind: 'all' }
  | { readonly kind: 'departments'; readonly ids: ReadonlySet<string> };

type Decision = AuthorizationDecision<CompositeResourceConditions>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 从 scope AST 收集 departmentId 的等值；遇到不认识的节点整份判为不可解析。 */
function departmentIdsOf(node: unknown): string[] | null {
  if (!isRecord(node)) return null;
  if (node.kind === 'condition') {
    const path = node.path;
    if (
      !Array.isArray(path) ||
      path.length !== 1 ||
      path[0] !== 'departmentId' ||
      node.operator !== '$eq' ||
      typeof node.value !== 'string'
    ) {
      return null;
    }
    return [node.value];
  }
  if (
    node.kind === 'group' &&
    (node.logic === 'or' || node.logic === 'and') &&
    Array.isArray(node.items)
  ) {
    // scopeAst 会把单个条件包进 and 组；多部门是 or 组。and 多条件不是「或」，
    // 解析成交集没有意义，按不可解析拒绝。
    if (node.logic === 'and' && node.items.length !== 1) return null;
    if (node.logic === 'or' && node.items.length === 0) return null;
    const ids: string[] = [];
    for (const item of node.items) {
      const part = departmentIdsOf(item);
      if (part === null) return null;
      ids.push(...part);
    }
    return ids;
  }
  return null;
}

/** 只读 `fqcTickets.read`；不查 permissionSets.getEffective，也不用 policyFor。 */
export function resolveTicketScope(read: unknown): TicketScope | null {
  if (read === true) return { kind: 'all' };
  if (!isRecord(read)) return null;
  const scope = read.scope;
  // allRecords 的真实形状：{scope: true, fields, relations}。与裸 true 等价。
  if (scope === true) return { kind: 'all' };
  if (!isRecord(scope)) return null;
  const ids = departmentIdsOf(scope.root);
  return ids === null ? null : { kind: 'departments', ids: new Set(ids) };
}

export function ticketScopeOfDecision(decision: Decision): TicketScope | null {
  const table = decision.conditions?.database?.fqcTickets;
  if (!table) return null;
  return resolveTicketScope(table.read);
}

/** 脱离请求按主体授权：转派的 guard 拿到的是 actor id，不是 Hono 上下文。 */
export async function ticketScopeFor(
  authorization: Authorization,
  actorId: string,
): Promise<TicketScope | null> {
  const decision = await authorization
    .for({ principal: { type: 'user', id: actorId } })
    .authorize({ resource: { type: 'composite', id: 'fqc' }, action: 'ticket' });
  if (decision.effect === 'deny' || decision.conditions?.database === undefined) {
    return null;
  }
  return ticketScopeOfDecision(decision);
}

/** 部门是否在调用者范围内；没有 departmentId 的存量工单对部门范围而言不在范围内。 */
export function inTicketScope(
  scope: TicketScope | null,
  departmentId: string | null | undefined,
): boolean {
  if (scope === null) return false;
  if (scope.kind === 'all') return true;
  if (typeof departmentId !== 'string' || departmentId.length === 0) return false;
  return scope.ids.has(departmentId);
}
