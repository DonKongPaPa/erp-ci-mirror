import { useEffect, useState } from 'react';

import type { QualityClient, DepartmentOptionNode } from './client.js';

/** 下拉里的一行：只有标识与显示名，不给编码、上级这些管理字段。 */
export interface DepartmentOption {
  id: string;
  title: string;
}

function flattenTree(
  nodes: readonly DepartmentOptionNode[],
  into: DepartmentOption[],
): void {
  for (const node of nodes) {
    // 停用的部门不进选项：派单与转派的目标部门都必须未停用，服务端也挡一道。
    if (node.active) into.push({ id: node.id, title: node.title });
    flattenTree(node.children, into);
  }
}

/**
 * 部门选项（工单卡的责任部门筛选用）：读一次 R-012 的部门树，摊平成下拉选项。
 * 调用者没有「查看部门」授权时端点回 403 —— 选项留空、错误放着不弹
 * （选项缺失是可见的，不用再弹一层）。
 */
export function useDepartmentOptions(
  client: QualityClient,
  enabled: boolean,
): {
  readonly options: readonly DepartmentOption[];
  readonly failed: boolean;
} {
  const [options, setOptions] = useState<readonly DepartmentOption[]>([]);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    client
      .listDepartmentTree()
      .then((tree) => {
        if (!active) return;
        const next: DepartmentOption[] = [];
        flattenTree(tree, next);
        setOptions(next);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [client, enabled]);
  return { options, failed };
}

/**
 * 在用部门的窄清单（`GET /quality/ticket-departments`，只回标识与显示名）：
 * 派单、转派与派单规则的三个下拉从这里来，持「处理」或「处理工单」即可调。
 * `loading` 在「enabled 为真但请求还没落定」期间为真 —— 包括 enabled 从 false
 * 变 true 的那一刻（派单规则的编辑框就是先挂着、点「编辑」才发请求的），
 * 请求在途不给「读不到部门清单」的说明；落定后没有选项或请求失败才给。
 * `loading` 是派生值：effect 体内同步 setState 会撞 `react-hooks/set-state-in-effect`，
 * 这里用「最近一次落定时的 enabled」推出来，行为与复查给的写法一致。
 */
export function useTicketDepartments(
  client: QualityClient,
  enabled: boolean,
): {
  readonly options: readonly DepartmentOption[];
  readonly failed: boolean;
  readonly loading: boolean;
} {
  const [options, setOptions] = useState<readonly DepartmentOption[]>([]);
  const [failed, setFailed] = useState(false);
  const [settledFor, setSettledFor] = useState<boolean | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    client
      .listTicketDepartments()
      .then((rows) => {
        if (!active) return;
        setOptions(rows.map((row) => ({ id: row.id, title: row.title })));
        setFailed(false);
        setSettledFor(true);
      })
      .catch(() => {
        if (!active) return;
        setFailed(true);
        setSettledFor(true);
      });
    return () => {
      active = false;
    };
  }, [client, enabled]);
  const loading = enabled && settledFor !== true;
  return { options, failed, loading };
}

/** 三个下拉共用的空态判据：请求落定后没有选项（失败或为空）就给说明。 */
export function departmentsUnavailable(result: {
  readonly failed: boolean;
  readonly loading: boolean;
  readonly options: readonly unknown[];
}): boolean {
  return !result.loading && (result.failed || result.options.length === 0);
}
