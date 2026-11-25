import type { DepartmentNode, DepartmentRecord } from './client.js';

/** 树转成扁平清单，带层级深度，供上级、继任者、合并目标的选择器使用。 */
export function flattenTree(
  nodes: readonly DepartmentNode[],
  depth = 0,
): { readonly node: DepartmentRecord; readonly depth: number }[] {
  return nodes.flatMap((node) => [
    { node, depth },
    ...flattenTree(node.children, depth + 1),
  ]);
}

/** 这个部门自己与它全部后代的 id。移动、合并、指定继任者时把这些从选项里去掉。 */
export function subtreeIds(
  nodes: readonly DepartmentNode[],
  departmentId: string,
): ReadonlySet<string> {
  const find = (
    items: readonly DepartmentNode[],
  ): DepartmentNode | undefined => {
    for (const item of items) {
      if (item.id === departmentId) {
        return item;
      }
      const nested = find(item.children);
      if (nested) {
        return nested;
      }
    }
    return undefined;
  };
  const collect = (node: DepartmentNode): string[] => [
    node.id,
    ...node.children.flatMap(collect),
  ];
  const target = find(nodes);
  return new Set(target ? collect(target) : []);
}

/** 显示用：姓名，其次用户名，最后标识；两者都为空时不显示空字符串。 */
export function personLabel(row: {
  readonly name: string | null;
  readonly username: string | null;
  readonly userId: string;
}): string {
  return row.name ?? row.username ?? row.userId;
}
