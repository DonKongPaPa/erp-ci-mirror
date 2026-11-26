// 测试库的本地连接参数来源：CI 由工作流注入，本机从主检出的 .local/test-pg.env 读。
// 文件位置由 git common-dir 回推，副本里也能找到主检出那一份。口令只进 env，绝不打印。
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

const CONNECTION_KEYS = [
  'POSTGRES_HOST',
  'POSTGRES_PORT',
  'POSTGRES_USER',
  'POSTGRES_PASSWORD',
  'POSTGRES_DATABASE',
] as const;

type ConnectionKey = (typeof CONNECTION_KEYS)[number];

const isConnectionKey = (value: string): value is ConnectionKey =>
  (CONNECTION_KEYS as readonly string[]).includes(value);

/** 主检出 .local/test-pg.env 的路径；不是 git 工作区时返回 undefined。 */
export function testDatabaseEnvFile(cwd = process.cwd()): string | undefined {
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (!commonDir) return undefined;
    return path.join(path.dirname(commonDir), '.local', 'test-pg.env');
  } catch {
    return undefined;
  }
}

/** 测试只连 Postgres：方言不可被环境变量改回 SQLite；本机缺参数就停下。 */
export function loadTestDatabaseEnv(
  env: Record<string, string | undefined> = process.env,
  cwd = process.cwd(),
): void {
  const requested = env.NOCOBASE_TEST_DB_DIALECT?.trim();
  if (requested && requested !== 'postgres') {
    throw new Error(`测试只连 Postgres；NOCOBASE_TEST_DB_DIALECT="${requested}" 不被接受。`);
  }
  env.NOCOBASE_TEST_DB_DIALECT = 'postgres';
  if (env.POSTGRES_HOST) return;

  // CI 的连接由工作流变量注入；docs 快道与「只起配置」档不连库，缺参数不算错。
  // 这个信号只放开「缺连接参数」，方言仍钉死在 postgres，连库档位照旧报错不回落。
  const ci = ['1', 'true'].includes(String(env.CI ?? '').toLowerCase()) ||
    ['1', 'true'].includes(String(env.GITHUB_ACTIONS ?? '').toLowerCase()) ||
    ['1', 'true'].includes(String(env.NOCOBASE_DOCS_ONLY ?? '').toLowerCase());
  const file = testDatabaseEnvFile(cwd);
  if (!file || !existsSync(file)) {
    if (ci) return;
    throw new Error('找不到测试库的连接参数；先跑 ./scripts/dev/up.sh --test-db，或由 CI 注入变量');
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const match = /^([A-Z_]+)=(.*)$/u.exec(line.trim());
    if (!match || !isConnectionKey(match[1])) continue;
    if (!env[match[1]]) env[match[1]] = match[2];
  }
  if (!env.POSTGRES_HOST) {
    if (ci) return;
    throw new Error('找不到测试库的连接参数；先跑 ./scripts/dev/up.sh --test-db，或由 CI 注入变量');
  }
}
