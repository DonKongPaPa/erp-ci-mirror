import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const gate = readFileSync(
  path.join(repoRoot, 'scripts', 'ci', 'gate.sh'),
  'utf8',
);

/**
 * R-056 收尾（复核第 5 点）：脱敏镜像不带 scripts/dev/，原先唯一守着 gate.sh
 * 方言与本地检查逻辑的 test-database-env.test.ts 因此整份被排除，镜像线上
 * 这段逻辑没有消费者。这一份只读白名单内的 scripts/ci/gate.sh，镜像也会跑，
 * 保留最低限度防线。不要在这里读 scripts/dev/、.agents/ 或 wiki/。
 */
describe('gate.sh 的测试库档位（可在镜像里跑）', () => {
  it('方言钉死为 postgres，显式别的方言被拒，没有 SQLite 回落', () => {
    expect(gate).toContain('export NOCOBASE_TEST_DB_DIALECT=postgres');
    expect(gate).toContain('[ "$NOCOBASE_TEST_DB_DIALECT" != "postgres" ]');
    expect(gate).not.toContain('export NOCOBASE_TEST_DB_DIALECT=sqlite');
    expect(gate).not.toContain('测试库回落 SQLite');
  });

  it('本地检查只在需要测试库的档位；fast 按改动路径判断', () => {
    expect(gate).toContain('need_test_db=1');
    expect(gate).toContain('changed-needs-db.sh');
    // 旧写法把 fast 与 unit/beta/all 一起无条件检查，只改文档也会卡在测试库上。
    expect(gate).not.toMatch(/fast\|unit\|beta\|all\)/u);
    expect(gate).toContain('scripts/ci/test-pg-check.sh');
  });

  it('不连库的档位给配置层一个显式信号，缺参数不报错但不回落', () => {
    expect(gate).toContain('NOCOBASE_DOCS_ONLY=1');
    expect(gate).toContain('export NOCOBASE_DOCS_ONLY=1');
  });
});
