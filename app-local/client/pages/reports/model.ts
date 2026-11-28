/** R-078 通用报表页的形状与格式：键白名单由 schema 端点给，页面不自己造键。 */

export const REPORT_CATEGORIES = ['purchase', 'sales', 'stock', 'finance'] as const;
export type ReportCategory = (typeof REPORT_CATEGORIES)[number];

export interface ReportBrief {
  readonly key: string;
  readonly titleKey: string;
  readonly category: ReportCategory;
}

export interface ReportColumn {
  readonly key: string;
  readonly labelKey: string;
  readonly type: 'text' | 'number' | 'date';
}

export interface ReportSchema {
  readonly dimensions: readonly string[];
  readonly measures: readonly string[];
  readonly columns: readonly ReportColumn[];
}

export interface RunReportInput {
  readonly filters: Readonly<Record<string, string | number | boolean | null>>;
  readonly dimensions: readonly string[];
  readonly measures: readonly string[];
  readonly page: number;
  readonly pageSize: number;
}

export interface ReportResult {
  readonly columns: readonly ReportColumn[];
  readonly items: readonly Record<string, string | number | null>[];
  readonly total: number;
  readonly page: number;
  readonly pageSize: number;
}

/** 空值画破折号；数字两位小数带千分位，别把缺数画成 0。 */
export function formatCell(
  value: string | number | null | undefined,
  type: ReportColumn['type'],
  locale: string,
): string {
  if (value === null || value === undefined || value === '') return '—';
  if (type === 'number' && typeof value === 'number')
    return new Intl.NumberFormat(locale, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  return String(value);
}
