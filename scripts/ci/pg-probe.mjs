// R-056 收尾 A1：从宿主侧用 env 里的凭据走 TCP 真连测试库。
// 容器内的 psql 走 loopback，镜像 pg_hba 对它是 trust —— 口令错了也照样返回 1，
// 验不出凭据写岔。这里按 POSTGRES_* 走 TCP，口令只在进程环境里，不进任何输出。
// R-059：顺带读 pg_postmaster_start_time()，闸门据此分辨「代码红了」与「测试库中途重启过」。
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
// pg 是 knex 的传递依赖，pnpm 把它提到 .pnpm/node_modules 这一层；从那里解析，
// 不写死版本号（升级依赖后仍找得到）。
const anchor = path.join(
  root, 'app-local', 'node_modules', '.pnpm', 'node_modules', 'pg-probe-anchor.cjs',
);
const nodeRequire = createRequire(anchor);
let Client;
try {
  ({ Client } = nodeRequire('pg'));
} catch {
  process.stderr.write('[pg-probe] 找不到 pg 客户端；先在 app-local 跑 pnpm install。\n');
  process.exit(2);
}

const { POSTGRES_HOST, POSTGRES_USER, POSTGRES_PASSWORD, POSTGRES_DATABASE } = process.env;
const port = Number(process.env.POSTGRES_PORT ?? 15432);
if (
  !POSTGRES_HOST || !POSTGRES_USER || !POSTGRES_PASSWORD || !POSTGRES_DATABASE ||
  !Number.isInteger(port)
) {
  process.stderr.write('[pg-probe] 缺少 POSTGRES_* 连接参数；先跑 ./scripts/dev/up.sh --test-db。\n');
  process.exit(2);
}

const client = new Client({
  host: POSTGRES_HOST,
  port,
  user: POSTGRES_USER,
  password: POSTGRES_PASSWORD,
  database: POSTGRES_DATABASE,
  connectionTimeoutMillis: 5000,
});
const startFile = process.env.PG_PROBE_START_TIME_FILE ?? '';
try {
  await client.connect();
  const { rows } = await client.query('select 1 as ok');
  if (rows[0]?.ok !== 1) throw new Error('unexpected probe result');
  const postmaster = await client.query('select pg_postmaster_start_time() as started_at');
  const startedAt = postmaster.rows[0]?.started_at;
  if (!(startedAt instanceof Date)) throw new Error('unexpected postmaster start time');
  const iso = startedAt.toISOString();
  if (startFile) {
    const resolved = path.resolve(startFile);
    mkdirSync(path.dirname(resolved), { recursive: true });
    writeFileSync(resolved, `${iso}\n`);
  }
  process.stdout.write(`[pg-probe] 测试库 TCP 连接正常（口令不回显），启动时刻 ${iso}\n`);
  await client.end();
  process.exit(0);
} catch (error) {
  // 只报错误码，不报 message —— 连接错误里可能带连接串，口令绝不进日志。
  const code = error && typeof error === 'object' && 'code' in error
    ? String(error.code) : 'CONNECTION_FAILED';
  process.stderr.write(`[pg-probe] 测试库 TCP 连不上（${code}）；凭据不对或容器状态不对。\n`);
  process.exit(1);
}
