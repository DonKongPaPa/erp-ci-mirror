import type { ApiClient } from '@nocobase/app-client';

import type { TransitionName } from './model.js';

export interface QualityMessage {
  id: string;
  channel: string;
  externalId: string | null;
  senderName: string | null;
  senderContact: string | null;
  content: string;
  rawContentType: string;
  receivedAt: string;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * 人工确认记录的一行（R-002）。列表已确认的行随行带最近一次记录，确认端点回刚写的那行；
 * `actorId` 留着排障，页面只显示服务端解析好的 `actorName`。
 */
export interface QualityScreeningReview {
  id: string;
  screeningId: string;
  kind: string;
  category: string;
  severity: string;
  departmentId: string | null;
  actorId: string;
  /** 姓名（解析不到时是中性占位）；服务端不回邮箱、手机号。 */
  actorName: string;
  createdAt: string;
}

export interface QualityScreening {
  id: string;
  messageId: string;
  category: string | null;
  severity: string | null;
  suggestedOwner: string | null;
  summary: string | null;
  confidence: string | null;
  evidence: unknown;
  modelName: string | null;
  // R-002 的六个出处列：这份草稿是谁出的、为什么没跑或回落、引了哪些知识、
  // 发出去之前脱没脱敏。`knowledgeRefs` 里 `kb:` 是知识库引用、`case:` 是相似案例。
  engine: string;
  promptVersion: string | null;
  degraded: boolean;
  degradeReason: string | null;
  knowledgeRefs: string[] | null;
  redacted: boolean;
  reviewId: string | null;
  outcome: string;
  /** 列表端点为每行算好的「这一行处于可以确认的状态」；列表之外不返回。 */
  canReview?: boolean;
  /** 列表已确认的行随行带最近一次确认（或 null）；确认端点回刚写下的那行。 */
  review?: QualityScreeningReview | null;
  createdAt: string;
  updatedAt: string;
}

/** 代填效果（R-002）：草稿与人工确认的对照，只有汇总数字。 */
export interface QualityDraftingStats {
  from: string;
  to: string;
  total: number;
  engines: { rules: number; model: number };
  degradeReasons: {
    'model-disabled': number;
    'model-not-configured': number;
    'model-error': number;
    timeout: number;
    'invalid-output': number;
  };
  redacted: number;
  confirmed: number;
  agreement: {
    category: { matched: number; mismatched: number };
    severity: { matched: number; mismatched: number };
  };
}

/**
 * 工单的一行（R-003）。责任部门是 R-012 的 `departmentId`，标题由服务端解析成
 * `departmentTitle`；经办人只回解析好的姓名 `assigneeName`，不回账号与邮箱。
 * 旧列 `ownerDepartment` / `dueAt` 已停写、接口里不再出现。
 */
export interface QualityTicket {
  id: string;
  code: string;
  title: string;
  description: string | null;
  sourceMessageId: string | null;
  screeningId: string | null;
  category: string | null;
  severity: string;
  departmentId: string | null;
  /** 服务端按部门标识解析出的显示名；解析不到为 null。 */
  departmentTitle: string | null;
  assigneeId: string | null;
  /** 服务端解析出的经办人姓名；没有经办人或解析不到为 null。 */
  assigneeName: string | null;
  state: string;
  /** 解决时写的处理说明；还没解决为 null。 */
  resolution: string | null;
  /** 重开过几次；迁移之后的行从 0 起算。 */
  reopenCount: number;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * 服务端按这一行的状态与调用者算好的可行转移（五个转移名的子数组）。
   * 客户端只用它决定按钮显不显示，不自己判断能不能流转。
   */
  canTransition?: readonly TransitionName[];
}

export interface TicketQuery {
  state?: string;
  departmentId?: string;
  assigneeId?: string;
  /** 只按工单的编号与标题匹配；服务端裁决，客户端只透传。 */
  q?: string;
  page?: number;
  pageSize?: number;
}

/** 工单详情：工单字段之外，还带确认记录与流转的历史。 */
export interface TicketReviewRecord {
  id: string;
  screeningId: string;
  kind: string;
  category: string;
  severity: string;
  departmentId: string | null;
  /** 服务端解析好的姓名；页面上不出现账号 id。 */
  actorName: string;
  createdAt: string;
}

export interface TicketTransitionRecord {
  id: string;
  name: string;
  fromState: string | null;
  toState: string;
  /** 服务端解析好的操作人姓名；解析不到为 null。 */
  actorName: string | null;
  createdAt: string;
}

export interface TicketDetail {
  ticket: QualityTicket;
  /** 调用者对确认记录表没有范围时是空数组（端点把读不到显式当空数组）。 */
  reviews: readonly TicketReviewRecord[];
  transitions: readonly TicketTransitionRecord[];
}

/** 帮手里的相似工单：只回六列，不回描述（那里面是客户的正文）。 */
export interface SimilarTicket {
  code: string;
  title: string;
  category: string | null;
  severity: string;
  resolution: string | null;
  closedAt: string | null;
}

/**
 * 帮手的返回：相似的工单，外加一段处理建议。处理建议要等模型接入，
 * 开关关着时 `suggestion` 是空的、`engine` 是 `none` —— 页面如实显示「等模型接入」。
 */
export interface TicketAssist {
  similar: readonly SimilarTicket[];
  suggestion: string | null;
  engine: string;
}

/** 搜同事的一行：标识、姓名、用户名三列；没有邮箱、手机号。 */
export interface TicketCandidate {
  id: string;
  name: string | null;
  username: string | null;
}

/** 派单规则的一行：类别到责任部门。没有配规则的类别 `departmentId` 是 null。 */
export interface RoutingRule {
  category: string;
  departmentId: string | null;
  /** 服务端解析好的部门显示名；解析不到为 null。 */
  departmentTitle: string | null;
}

/** 一条待写的派单规则：类别到责任部门，`null` 表示这一类不配规则。 */
export interface RoutingRuleInput {
  category: string;
  departmentId: string | null;
}

export interface ListResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** 部门树节点的页面用子集：只取标识、显示名与停用标记，其余字段不进页面。 */
export interface DepartmentOptionNode {
  id: string;
  title: string;
  active: boolean;
  children: readonly DepartmentOptionNode[];
}

/** 在用部门的窄清单里的一行：只有标识与显示名。 */
export interface TicketDepartmentOption {
  id: string;
  title: string;
}

/** 派单 201 回的新建工单一行（服务端的 DispatchedTicketSchema）。 */
export type DispatchedTicket = QualityTicket;

/**
 * 质量页的读取与写入客户端。写操作在对话框里带各自的提交状态；
 * 幂等语义由服务端裁决，客户端不发明新的幂等键。
 */
export class QualityClient {
  constructor(private readonly api: ApiClient) {}

  listTickets(query: TicketQuery = {}): Promise<ListResult<QualityTicket>> {
    return this.api
      .request<{ data: QualityTicket[]; meta?: Record<string, unknown> }>({
        path: 'quality/tickets',
        query: Object.fromEntries(
          Object.entries(query).filter(([, value]) => value !== undefined),
        ),
      })
      .then(({ data, meta }) => ({
        items: data,
        total: (meta?.total as number) ?? 0,
        page: (meta?.page as number) ?? 1,
        pageSize: (meta?.pageSize as number) ?? 20,
      }));
  }

  /**
   * 部门树（R-012）：工单卡的责任部门筛选从这里来（筛选是对持「查看」的人开放）。
   * 调用者没有「查看部门」授权时端点回 403，调用方按空选项处理。
   */
  async listDepartmentTree(): Promise<readonly DepartmentOptionNode[]> {
    const { data } = await this.api.request<{
      data: readonly DepartmentOptionNode[];
    }>({
      path: 'departments/tree',
    });
    return data;
  }

  /**
   * 在用部门的窄清单：只回标识与显示名两列。派单、转派与派单规则的部门下拉
   * 从这里来；持「处理」或「处理工单」即可调，读不到时页面给一句说明。
   */
  async listTicketDepartments(): Promise<readonly TicketDepartmentOption[]> {
    const { data } = await this.api.request<{
      data: readonly TicketDepartmentOption[];
    }>({
      path: 'quality/ticket-departments',
    });
    return data;
  }

  /** 一张工单：工单字段、确认记录、流转的历史。 */
  async getTicket(ticketId: string): Promise<TicketDetail> {
    const { data } = await this.api.request<{ data: TicketDetail }>({
      path: `quality/tickets/${encodeURIComponent(ticketId)}`,
    });
    return data;
  }

  /**
   * 流转：`name` 是五个转移之一，`input` 是转移自己的字段（受理的经办人、
   * 解决的处理说明、关闭的备注、重开的原因、转派的新部门与经办人）。
   * 真正的规则在服务端的守卫里，客户端只把表单值带上。
   */
  fireTransition(
    ticketId: string,
    name: TransitionName,
    input: Record<string, string | null> = {},
  ): Promise<unknown> {
    return this.api.request({
      path: `quality/tickets/${encodeURIComponent(ticketId)}/transitions`,
      method: 'POST',
      json: { name, ...(Object.keys(input).length > 0 ? { input } : {}) },
    });
  }

  /** 只换经办人，不换部门；`null` 表示清空。 */
  setAssignee(ticketId: string, assigneeId: string | null): Promise<unknown> {
    return this.api.request({
      path: `quality/tickets/${encodeURIComponent(ticketId)}/assignee`,
      method: 'POST',
      json: { assigneeId },
    });
  }

  /**
   * 给处理人的帮手：相似的工单（不含描述）与处理建议。
   * 只有持「处理工单」的人能调，页面按权限决定要不要发这个请求。
   */
  async assist(ticketId: string): Promise<TicketAssist> {
    const { data } = await this.api.request<{ data: TicketAssist }>({
      path: `quality/tickets/${encodeURIComponent(ticketId)}/assist`,
    });
    return data;
  }

  /**
   * 搜同事：只在指定责任部门的成员里搜，关键字只按姓名与用户名匹配。
   * `q` 必填（1–64 字符），空关键字不发请求。
   */
  searchCandidates(
    departmentId: string,
    q: string,
  ): Promise<ListResult<TicketCandidate>> {
    return this.api
      .request<{ data: TicketCandidate[]; meta?: Record<string, unknown> }>({
        path: 'quality/ticket-candidates',
        query: { departmentId, q },
      })
      .then(({ data, meta }) => ({
        items: data,
        total: (meta?.total as number) ?? 0,
        page: (meta?.page as number) ?? 1,
        pageSize: (meta?.pageSize as number) ?? 20,
      }));
  }

  /** 派单规则：七个类别与各自的部门。 */
  async getRoutingRules(): Promise<ListResult<RoutingRule>> {
    const { data } = await this.api.request<{ data: RoutingRule[] }>({
      path: 'quality/routing-rules',
    });
    return { items: data, total: data.length, page: 1, pageSize: data.length };
  }

  /** 派单规则整体替换：七个类别一次写全，`departmentId` 为 null 表示不配规则。 */
  async putRoutingRules(
    rules: readonly RoutingRuleInput[],
  ): Promise<ListResult<RoutingRule>> {
    const { data } = await this.api.request<{ data: RoutingRule[] }>({
      path: 'quality/routing-rules',
      method: 'PUT',
      json: { rules: rules.map((rule) => ({ ...rule })) },
    });
    return { items: data, total: data.length, page: 1, pageSize: data.length };
  }

  listMessages(): Promise<ListResult<QualityMessage>> {
    return this.api
      .request<{ data: QualityMessage[]; meta?: Record<string, unknown> }>({
        path: 'quality/messages',
      })
      .then(({ data, meta }) => ({
        items: data,
        total: (meta?.total as number) ?? 0,
        page: 1,
        pageSize: 50,
      }));
  }

  listScreenings(): Promise<ListResult<QualityScreening>> {
    return this.api
      .request<{ data: QualityScreening[]; meta?: Record<string, unknown> }>({
        path: 'quality/screenings',
      })
      .then(({ data, meta }) => ({
        items: data,
        total: (meta?.total as number) ?? 0,
        page: 1,
        pageSize: 50,
      }));
  }

  /** 代填效果（R-002）：区间落在初筛的 createdAt 上，两端必填、跨度不超过一年。 */
  draftingStats(range: { from: string; to: string }): Promise<QualityDraftingStats> {
    return this.api
      .request<{ data: QualityDraftingStats }>({
        path: 'quality/drafting/stats',
        query: { from: range.from, to: range.to },
      })
      .then(({ data }) => data);
  }

  /** 确认一条初筛（还没有工单时）；有了工单就是改判，从工单详情发起。 */
  review(
    screeningId: string,
    input: {
      category?: string;
      severity?: string;
      /** 与工单不同的部门走转派端点；服务端以 422 USE_REASSIGN 挡在这里的误用。 */
      departmentId?: string;
    } = {},
  ): Promise<QualityScreening> {
    return this.api
      .request<{ data: QualityScreening }>({
        path: `quality/screenings/${encodeURIComponent(screeningId)}/review`,
        method: 'POST',
        json: input,
      })
      .then(({ data }) => data);
  }

  /**
   * 确认并派单：把一份草稿变成工单。四个值都可缺省 —— 类别、严重度按
   * 请求 → 确认记录 → 草稿取，责任部门按请求 → 确认记录 → 派单规则取，
   * 经办人只取请求。服务端以 409 挡同一份草稿的第二张单。
   */
  dispatch(
    screeningId: string,
    input: {
      category?: string;
      severity?: string;
      departmentId?: string;
      assigneeId?: string;
    } = {},
  ): Promise<DispatchedTicket> {
    return this.api
      .request<{ data: DispatchedTicket }>({
        path: `quality/screenings/${encodeURIComponent(screeningId)}/dispatch`,
        method: 'POST',
        json: input,
      })
      .then(({ data }) => data);
  }
}
