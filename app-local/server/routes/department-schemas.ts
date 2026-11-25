import { z } from 'zod';

/**
 * R-012 部门端点用到的请求与响应形状。
 *
 * 有两个字段故意不在 zod 里卡死取值，留给处理器按设计的状态码表回 422：
 * - `code`：建部门不带编码是 422，而框架的 zod 校验失败一律 400
 * - `kind`：类型不在四种之内是 422，同上
 * 其余输入（标题长度、各个 id 长度、排序号的 32 位范围）由这里的校验挡住，
 * SQLite 不强制这些，Postgres 强制，所以要在端点上卡。
 */
const id = z.string().min(1).max(64);

export const DepartmentKindSchema = z.enum([
  'company',
  'center',
  'department',
  'team',
]);

export const DepartmentSchema = z.object({
  id: z.string(),
  title: z.string(),
  parentId: z.string().nullable(),
  managerId: z.string().nullable(),
  active: z.boolean(),
  sortOrder: z.number(),
  kind: DepartmentKindSchema,
  code: z.string(),
  successorId: z.string().nullable(),
  succeededAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type DepartmentResponse = z.infer<typeof DepartmentSchema>;

export type DepartmentTreeNode = DepartmentResponse & {
  readonly children: readonly DepartmentTreeNode[];
};

export const DepartmentTreeNodeSchema: z.ZodType<DepartmentTreeNode> =
  DepartmentSchema.extend({
    children: z.array(z.lazy(() => DepartmentTreeNodeSchema)),
  });

/**
 * 搜人结果只回标识、姓名、用户名三列：不回邮箱（R-028 的选择性暴露）。
 * 成员列表在这个基础上多一个 `isPrimary` —— 它是成员关系的事实，不是个人属性。
 */
export const CandidateSchema = z.object({
  userId: z.string(),
  name: z.string().nullable(),
  username: z.string().nullable(),
});

/** 成员接口只回标识、姓名、用户名与「是不是主部门」：不回邮箱。 */
export const DepartmentMemberSchema = CandidateSchema.extend({
  isPrimary: z.boolean(),
});

export const MembershipSchema = z.object({
  id: z.string(),
  departmentId: z.string(),
  userId: z.string(),
  isPrimary: z.boolean(),
  createdAt: z.string(),
});

export const CreateDepartmentBody = z.object({
  title: z.string().trim().min(1).max(128),
  code: z.string().trim().max(64).optional(),
  kind: z.string().trim().max(32).optional(),
  parentId: id.nullable().optional(),
  sortOrder: z.number().int().min(-2147483648).max(2147483647).optional(),
});

export const UpdateDepartmentBody = z.object({
  title: z.string().trim().min(1).max(128).optional(),
  code: z.string().trim().max(64).optional(),
  kind: z.string().trim().max(32).optional(),
  parentId: id.nullable().optional(),
  sortOrder: z.number().int().min(-2147483648).max(2147483647).optional(),
  managerId: id.nullable().optional(),
});

export const DeactivateDepartmentBody = z.object({
  successorId: id.optional(),
});

export const MergeDepartmentBody = z.object({
  targetId: id.optional(),
});

export const AddMembersBody = z.object({
  userIds: z.array(id).optional(),
});

export const TransferMembersBody = z.object({
  userIds: z.array(id).optional(),
  fromDepartmentId: id.optional(),
  toDepartmentId: id.optional(),
});

export const ListDepartmentMembersQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * 搜人端点（`/departments/candidates`）的查询参数。
 *
 * `q` 必填：去首尾空白后 1 到 64 个字符，否则 400。每页默认 20、上限 50
 * （R-012「接口契约」的「搜人的端点」）。`excludeDepartmentId` 可选：把这个部门
 * 的现有成员排除掉，页面「加成员」时已经在成员里的不再出现。
 */
export const CandidateQuery = z.object({
  q: z.string().trim().min(1).max(64),
  excludeDepartmentId: z.string().min(1).max(64).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

export const AddMembersResultSchema = z.object({
  added: z.array(z.string()),
  skipped: z.array(z.string()),
});

export const MergeResultSchema = z.object({
  moved: z.number(),
  removed: z.number(),
  department: DepartmentSchema,
});

export const TransferResultSchema = z.object({
  moved: z.number(),
  removed: z.number(),
});
