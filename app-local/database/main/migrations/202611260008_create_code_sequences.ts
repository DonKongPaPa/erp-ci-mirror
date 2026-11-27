import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-016 MVP：统一发号器的计数器表，排在未合并的 202611260007_create_shifts 之后。
 * 不改任何已执行的迁移，这是本片唯一的新表。
 *
 * 一行就是一个 (前缀, 周期) 的发号进度：按日重置的规则 period 存 Asia/Shanghai 的
 * yyyymmdd（列宽 8 正好）；不带日期的规则存空串。last_no 是发到几号，默认 0，第一条 INSERT … ON
 * CONFLICT 的 DO UPDATE 把它加到 1。序号位数、进位方式、是否带日期都是代码常量
 * （Q41），表里没有规则列。
 *
 * 主键 (prefix, period) 同时是并发下的唯一约束：两个事务抢同一行，行锁由数据库
 * 持有到事务结束，号随业务事务提交，回滚即归还。down 显式删表，主键随之消失。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260008_create_code_sequences',
  async up({ builder }) {
    await builder.createCollection('codeSequences', (collection) => {
      collection.string('prefix', { length: 16 }).notNull();
      collection.string('period', { length: 8 }).notNull();
      collection.integer('lastNo').notNull().defaultTo(0);
      collection.primary(['prefix', 'period'], { name: 'pk_code_sequences' });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('codeSequences');
  },
});

export default migration;
