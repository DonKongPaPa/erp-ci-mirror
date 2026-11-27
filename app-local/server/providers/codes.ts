import type { Application } from '@nocobase/app-server/application';
import type { DatabaseConnection } from '@nocobase/db';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';
import type { Knex } from 'knex';

/**
 * R-016 MVP：统一发号器。只做发号本身 —— 没有页面、没有 HTTP 端点、没有新授权。
 * 别的模块在自己的业务事务里调用 nextCode 领号，号随那个事务提交才生效。
 *
 * 格式（用户已裁 Q39，按原设计稿例子的样式，用户可推翻）：前缀-yyyymmdd-四位序号
 * （例 M-20261127-0001），四位满了自动进位到五位。个别前缀可以选 period: 'none'
 * 不带日期、不重置（例 CU-0001，现在用不到，但要能用）。
 * 日期按 Asia/Shanghai 算，不依赖进程时区。
 *
 * 2026-11-28 起新发的四类单据号用照旧系统（百卓轻云）的前缀：
 * 采购订单 CG、销售订单 XS、入库单 RK、出库单 CK。已经发出去的 PO / SO / IN / OUT
 * 号保留原值，不写迁移改库、不做重编号；形状仍是「前缀-yyyymmdd-四位序号」，规则仍不可配（Q41）。
 */
export const CODE_PREFIXES = {
  item: 'M',
  product: 'P',
  customer: 'CU',
  supplier: 'SU',
  purchaseOrder: 'CG',
  salesOrder: 'XS',
  inbound: 'RK',
  outbound: 'CK',
  // R-065：支出单号与到票编号的占位前缀（待 R-016 待裁 a 一并定）。
  expense: 'EXP',
  invoiceReceipt: 'RCV',
  // R-021 波 1 加片：请购单号的占位前缀（设计列为待补查，随 R-016 待裁一并定）。
  purchaseRequest: 'QG',
} as const;

/** 计数器行的周期：按日重置存 yyyymmdd（列宽 8 正好），不带日期存空串。 */
export type CodePeriod = 'day' | 'none';
/** 满位时进位（编码变长）或拒绝。 */
export type CodeExhaust = 'grow' | 'reject';

export interface NextCodeOptions {
  /** 默认 day：按 Asia/Shanghai 自然日重置。none 不带日期、不重置。 */
  readonly period?: CodePeriod;
  /** 序号位数，默认 4。 */
  readonly width?: number;
  /** 默认 grow：满位进位、不失败；reject 抛 code-exhausted。 */
  readonly onExhaust?: CodeExhaust;
  /** 测试注入的时钟；生产不传，取真实时间。 */
  readonly now?: Date;
}

export interface CodeService {
  /** 在调用方的事务里领一个号；调用方回滚时号随之回滚（不补号）。 */
  nextCode(
    tx: DatabaseConnection,
    prefix: string,
    options?: NextCodeOptions,
  ): Promise<string>;
}

export type CodeRuleCode = 'code-exhausted' | 'invalid-prefix';

export class CodeRuleError extends Error {
  public constructor(
    readonly code: CodeRuleCode,
    readonly detail?: string,
  ) {
    super(detail ?? `Code rule violated: ${code}`);
    this.name = 'CodeRuleError';
  }
}

/** Asia/Shanghai 的自然日，八位 yyyymmdd；与进程时区无关。 */
export function businessPeriod(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const part = (type: string): string =>
    parts.find((item) => item.type === type)?.value ?? '';
  return `${part('year')}${part('month')}${part('day')}`;
}

/**
 * 一条语句领号。INSERT 命中主键冲突时把 last_no 加一再返回，行锁留到事务结束。
 * 两个连接同时领同一 (前缀, 周期) 必然串行，拿到的号不重复；调用方回滚则整行改动撤销。
 */
const TAKE_NUMBER_SQL = `
  INSERT INTO code_sequences (prefix, period, last_no)
  VALUES (?, ?, 1)
  ON CONFLICT (prefix, period)
  DO UPDATE SET last_no = code_sequences.last_no + 1
  RETURNING last_no
`;

export class DatabaseCodeService implements CodeService {
  public async nextCode(
    tx: DatabaseConnection,
    prefix: string,
    options: NextCodeOptions = {},
  ): Promise<string> {
    if (prefix.length < 1 || prefix.length > 16) {
      throw new CodeRuleError('invalid-prefix', prefix);
    }
    const period =
      (options.period ?? 'day') === 'none'
        ? ''
        : businessPeriod(options.now ?? new Date());
    const width = options.width ?? 4;
    const exhaust = options.onExhaust ?? 'grow';

    // reject 模式在领号前先看当前值，满位就抛错，不给计数器留下多出来的行。
    // grow 模式不需要这一步：满位后数字自然变长，不报错。
    if (exhaust === 'reject') {
      const knex = await tx.client<Knex>();
      const row = await knex('code_sequences')
        .where({ prefix, period })
        .first<{ last_no?: number | string } | undefined>();
      if (row !== undefined && Number(row.last_no) >= 10 ** width - 1) {
        throw new CodeRuleError('code-exhausted');
      }
    }

    const knex = await tx.client<Knex>();
    // pg 的 raw 结果是 { rows: [...] }；这里显式标注形状，避免把 any 带进业务代码。
    const result = await knex.raw<{
      rows?: readonly { last_no?: number | string }[];
    }>(TAKE_NUMBER_SQL, [prefix, period]);
    const lastNo = result.rows?.[0]?.last_no;
    const seq = Number(lastNo);
    if (!Number.isSafeInteger(seq) || seq < 1) {
      throw new Error(`Unexpected last_no from code_sequences: ${String(lastNo)}`);
    }
    const serial = String(seq).padStart(width, '0');
    return period === '' ? `${prefix}-${serial}` : `${prefix}-${period}-${serial}`;
  }
}

export const codeServiceToken: ServiceToken<CodeService> =
  createServiceToken<CodeService>('app/code-service');

export default class CodesProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.codes';

  public override register(): void {
    this.app.container.singleton(codeServiceToken, () => new DatabaseCodeService());
  }
}
