import { z } from 'zod';

/** R-017 M3：审批端点共用的 zod schema。只收端点真正需要的字段。 */
const id = z.string().min(1);
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(100).default(20);
const keyword = z.string().max(200).optional();

export const MineQuery = z.object({
  scope: z.enum(['active', 'completed', 'all']).default('active'),
  page,
  pageSize,
  q: keyword,
  sortBy: z.enum(['createdAt', 'updatedAt', 'status']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export const TasksQuery = z.object({
  scope: z.enum(['pending', 'done']).default('pending'),
  page,
  pageSize,
  q: keyword,
  sortBy: z.enum(['createdAt', 'actedAt', 'dueAt']).default('createdAt'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});

export const ApprovalIdParam = z.object({ id });

export const CreateApprovalBody = z.object({
  collectionName: z.string().min(1).max(64),
  dataKey: z.string().min(1).max(64),
  workflowKey: z.string().min(1).max(64),
  data: z.record(z.string(), z.unknown()).default({}),
  submit: z.boolean(),
});

export const UpdateApprovalBody = z.object({
  data: z.record(z.string(), z.unknown()).optional(),
  submit: z.boolean(),
});

const comment = z.string().max(2000).optional();

export const DecideBody = z.object({
  comment,
  data: z.record(z.string(), z.unknown()).optional(),
});

export const ReturnBody = DecideBody.extend({
  returnToNodeKey: z.string().max(64).optional(),
});

export const DelegateBody = z.object({
  toUserId: id,
  comment,
});

export const AddSignBody = z.object({
  userIds: z.array(id).min(1).max(20),
  comment,
  position: z.enum(['before', 'after']).default('before'),
});

export const CandidatesQuery = z.object({
  type: z.enum(['delegate', 'add']),
  q: z.string().max(200).default(''),
  page,
  pageSize,
});

export const TaskIdParam = z.object({ id });
