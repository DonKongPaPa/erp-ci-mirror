import { z } from 'zod';

/** R-078：page/pageSize 的范围在引擎里判，失败回 REPORT_PAGE_INVALID，不交给 zod 兜。 */
const page = z.coerce.number().int().optional();
const pageSize = z.coerce.number().int().optional();
const filterValue = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const brief = z.object({
  key: z.string(), titleKey: z.string(),
  category: z.enum(['purchase', 'sales', 'stock', 'finance']),
});
const column = z.object({
  key: z.string(), labelKey: z.string(), type: z.enum(['text', 'number', 'date']),
});

export const ReportListQuery = z.object({
  category: z.enum(['purchase', 'sales', 'stock', 'finance']).optional(),
  q: z.string().max(128).optional(),
  page, pageSize,
});
export const RunReportBody = z.object({
  filters: z.record(z.string(), filterValue).default({}),
  dimensions: z.array(z.string().max(64)).optional(),
  measures: z.array(z.string().max(64)).optional(),
  page, pageSize,
});
export const TraceListQuery = z.object({
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).optional(),
  reportKey: z.string().max(64).optional(),
  userId: z.string().max(64).optional(),
  page, pageSize,
});

export const ReportBriefSchema = brief;
export const ReportListSchema = z.object({
  items: z.array(brief), total: z.number(), page: z.number(), pageSize: z.number(),
});
export const ReportSchemaSchema = z.object({
  dimensions: z.array(z.string()), measures: z.array(z.string()), columns: z.array(column),
});
export const ReportResultSchema = z.object({
  columns: z.array(column),
  items: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.null()]))),
  total: z.number(), page: z.number(), pageSize: z.number(),
});
export const FavoriteSchema = z.object({ favorited: z.boolean() });
export const FavoriteListSchema = z.object({ items: z.array(brief) });
export const ExportTraceSchema = z.object({
  id: z.string(), userId: z.string(), reportKey: z.string(), at: z.string(),
  format: z.literal('csv'), filtersHash: z.string(), rowCount: z.number(),
  user: z.object({ userId: z.string(), name: z.string() }),
});
export const ExportTraceListSchema = z.object({
  items: z.array(ExportTraceSchema), total: z.number(),
});
