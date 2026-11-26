import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const UP_SOURCE = readFileSync(path.join(REPO_ROOT, 'scripts/dev/up.sh'), 'utf8');
const SPLITTER = '# ---------- 主流程 ----------';
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(file: string, body: string, mode = 0o644): void {
  writeFileSync(file, body, { mode });
}

/**
 * 把 up.sh 的判断函数单独拿出来跑：截掉主流程，函数定义写进 /tmp 的 harness，
 * 末尾接一段 driver。podman、kill 都是 PATH 里的假命令，绝不碰真容器与真进程。
 */
function runHarness(
  dir: string,
  driver: string,
  opts: { env?: Record<string, string>; vars?: Record<string, string> } = {},
) {
  const cut = UP_SOURCE.indexOf(SPLITTER);
  expect(cut, 'up.sh 里必须有主流程分隔符').toBeGreaterThan(0);
  const scripts = path.join(dir, 'scripts', 'dev');
  mkdirSync(scripts, { recursive: true });
  const harness = path.join(scripts, 'up-funcs.sh');
  // 变量必须在函数定义之后覆盖：up.sh 自己会重新赋值，env 里的同名变量会被冲掉。
  const overrides = Object.entries(opts.vars ?? {})
    .map(([key, value]) => `${key}='${value.replaceAll("'", "'\\''")}'`)
    .join('\n');
  // kill 是 bash 内建命令：不关掉它，PATH 里的假 kill 永远不会被调用。
  writeFile(
    harness,
    `${UP_SOURCE.slice(0, cut)}\nenable -n kill\n${overrides}\n${driver}\n`,
  );

  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  writeFile(
    path.join(bin, 'podman'),
    [
      '#!/bin/sh',
      'case "$1" in',
      '  ps)',
      "    if [ \"$3\" = '{{.Names}}' ]; then cut -f1 \"$FAKE_PODMAN_PS\";",
      '    else cat "$FAKE_PODMAN_PS"; fi ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n') + '\n',
    0o755,
  );
  // 假 kill：只记账。-0 回报存活，收到 TERM/KILL 后回报已退出；绝不真的发信号。
  writeFile(
    path.join(bin, 'kill'),
    [
      '#!/bin/sh',
      'printf \'%s\\n\' "$*" >> "$FAKE_KILL_LOG"',
      'case "$1" in',
      '  -0) [ -f "$FAKE_PROC_DEAD" ] && exit 1; exit 0 ;;',
      '  -TERM|-KILL) : > "$FAKE_PROC_DEAD"; exit 0 ;;',
      'esac',
      'exit 0',
    ].join('\n') + '\n',
    0o755,
  );

  return spawnSync('bash', [harness], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ''}`,
      FAKE_PODMAN_PS: path.join(dir, 'ps.txt'),
      FAKE_KILL_LOG: path.join(dir, 'kill.log'),
      FAKE_PROC_DEAD: path.join(dir, 'dead'),
      ...(opts.env ?? {}),
    },
  });
}

function flagsFrom(result: { stdout: string }): Record<string, string> {
  return Object.fromEntries(
    result.stdout
      .trim()
      .split('\n')
      .map((line) => line.split('=') as [string, string]),
  );
}

function readKillLog(dir: string): string {
  const file = path.join(dir, 'kill.log');
  return existsSync(file) ? readFileSync(file, 'utf8') : '';
}

const FLAGS_DRIVER = [
  'for fn in pg_running pg_healthy test_pg_running test_pg_healthy; do',
  '  if "$fn"; then printf \'%s=true\\n\' "$fn"; else printf \'%s=false\\n\' "$fn"; fi',
  'done',
].join('\n');

describe('up.sh A8：健康检查按精确容器名匹配', () => {
  it('开发库停、测试库健康时，开发库两项都是假，测试库两项都是真', () => {
    const dir = tempDir('hs-up-a8-prefix-');
    writeFile(path.join(dir, 'ps.txt'), 'hs-erp-pg-test\tUp 5 minutes (healthy)\n');
    const result = runHarness(dir, FLAGS_DRIVER);
    expect(result.status).toBe(0);
    expect(flagsFrom(result)).toEqual({
      pg_running: 'false',
      pg_healthy: 'false',
      test_pg_running: 'true',
      test_pg_healthy: 'true',
    });
  });

  it('同名前缀的无关容器健康，也不会顶替开发库', () => {
    const dir = tempDir('hs-up-a8-suffix-');
    writeFile(path.join(dir, 'ps.txt'), 'hs-erp-pg-extra\tUp 5 minutes (healthy)\n');
    expect(flagsFrom(runHarness(dir, FLAGS_DRIVER))).toEqual({
      pg_running: 'false',
      pg_healthy: 'false',
      test_pg_running: 'false',
      test_pg_healthy: 'false',
    });
  });

  it('两个库都在跑、开发库未就绪时，只给测试库打健康勾', () => {
    const dir = tempDir('hs-up-a8-mixed-');
    writeFile(
      path.join(dir, 'ps.txt'),
      'hs-erp-pg\tUp 5 minutes (unhealthy)\nhs-erp-pg-test\tUp 5 minutes (healthy)\n',
    );
    expect(flagsFrom(runHarness(dir, FLAGS_DRIVER))).toEqual({
      pg_running: 'true',
      pg_healthy: 'false',
      test_pg_running: 'true',
      test_pg_healthy: 'true',
    });
  });

  it('--status 的报告里，开发库那行不打假绿勾', () => {
    const dir = tempDir('hs-up-a8-status-');
    writeFile(path.join(dir, 'ps.txt'), 'hs-erp-pg-test\tUp 5 minutes (healthy)\n');
    const bin = path.join(dir, 'bin');
    mkdirSync(bin, { recursive: true });
    writeFile(path.join(bin, 'curl'), '#!/bin/sh\nexit 1\n', 0o755);
    writeFile(path.join(bin, 'node'), "#!/bin/sh\nprintf 'v24.0.0\\n'\n", 0o755);
    const result = runHarness(dir, 'status_report');
    const pgLine = result.stdout.split('\n').find((line) => line.includes('PostgreSQL')) ?? '';
    const testLine = result.stdout.split('\n').find((line) => line.includes('测试库 PG')) ?? '';
    expect(pgLine).toContain('未运行');
    expect(pgLine).not.toContain('✅');
    expect(testLine).toContain('✅ 运行中且健康');
  });
});

interface ProcSpec {
  cmdline: string[];
  cwd: string;
  startEpoch: number;
}

const STOP_DRIVER = [
  'printf \'app_running=\'; if app_running; then echo true; else echo false; fi',
  'stop_app',
  'if [ -f "$APP_PID" ]; then echo pidfile=yes; else echo pidfile=no; fi',
].join('\n');

/** 造一份假的 /proc 与 pid 文件；mtime 与进程启动时间都可控，不碰真进程。 */
function runStop(
  dir: string,
  spec: ProcSpec,
  pidFileEpoch: number,
  bootEpoch = 1_700_000_000,
) {
  const pid = 424242;
  const proc = path.join(dir, 'proc');
  mkdirSync(path.join(proc, String(pid)), { recursive: true });
  writeFile(
    path.join(proc, String(pid), 'cmdline'),
    spec.cmdline.join('\0') + '\0',
  );
  symlinkSync(spec.cwd, path.join(proc, String(pid), 'cwd'), 'dir');
  // /proc/<pid>/stat 第 22 个字段是 starttime（自开机起的 tick），去掉 pid (comm) 后是第 20 个。
  const ticks = Math.round((spec.startEpoch - bootEpoch) * 100);
  // 第 22 个字段之前有 19 个字段（state 到 itrealvalue），少一个就会把 starttime 读成 0。
  const beforeStart = ['S', '1', '1', '1', '0', '-1', ...Array.from({ length: 13 }, () => '0')];
  const stat = `${pid} (fake) ${beforeStart.join(' ')} ${ticks} 0 0 0 0 0 0 0`;
  writeFile(path.join(proc, String(pid), 'stat'), `${stat}\n`);
  writeFile(path.join(proc, 'stat'), `btime ${bootEpoch}\n`);

  const pidFile = path.join(dir, 'dev-app.pid');
  writeFile(pidFile, `${pid}\n`);
  const when = new Date(pidFileEpoch * 1000);
  utimesSync(pidFile, when, when);

  const appDir = path.join(dir, 'app-local');
  mkdirSync(appDir, { recursive: true });
  const result = runHarness(dir, STOP_DRIVER, {
    vars: { APP_PID: pidFile, APP_PROC_ROOT: proc, APP_DIR: appDir },
  });
  return { result, pidFile, tickLog: readKillLog(dir) };
}

describe('up.sh A9：发信号前核对 pid 身份', () => {
  const boot = 1_700_000_000;
  const pidFileEpoch = boot + 1000;

  it('pid 被无关进程复用时，不当成应用在跑，也不发任何信号', () => {
    const dir = tempDir('hs-up-a9-reuse-');
    const { result, tickLog } = runStop(
      dir,
      { cmdline: ['sleep', '600'], cwd: '/', startEpoch: pidFileEpoch + 500 },
      pidFileEpoch,
      boot,
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('app_running=false');
    expect(tickLog).not.toMatch(/-TERM|-KILL/u);
    expect(result.stdout).toContain('pidfile=no');
  });

  it('cmdline 对不上或 cwd 不在 app-local，都不发信号', () => {
    for (const bad of [
      { cmdline: ['pnpm', 'dev'], cwd: '/tmp' },
      { cmdline: ['node', 'other.js'], cwd: 'APP_DIR' },
    ]) {
      const dir = tempDir('hs-up-a9-identity-');
      const { result, tickLog } = runStop(
        dir,
        { ...bad, startEpoch: pidFileEpoch - 1 } as ProcSpec,
        pidFileEpoch,
        boot,
      );
      expect(result.stdout).toContain('app_running=false');
      expect(tickLog).not.toMatch(/-TERM|-KILL/u);
    }
  });

  it('进程启动晚于 pid 文件落盘（陈旧文件被复用）时不发信号', () => {
    const dir = tempDir('hs-up-a9-starttime-');
    const { result, tickLog } = runStop(
      dir,
      {
        cmdline: ['pnpm', 'dev'],
        cwd: path.join(dir, 'app-local'),
        startEpoch: pidFileEpoch + 300,
      },
      pidFileEpoch,
      boot,
    );
    expect(result.stdout).toContain('app_running=false');
    expect(tickLog).not.toMatch(/-TERM|-KILL/u);
  });

  it('进程晚 0.8 秒启动、与 pid 文件落在同一整秒时也不认', () => {
    const dir = tempDir('hs-up-a9-same-second-');
    const { result, tickLog } = runStop(
      dir,
      {
        cmdline: ['pnpm', 'dev'],
        cwd: path.join(dir, 'app-local'),
        startEpoch: pidFileEpoch + 0.8,
      },
      pidFileEpoch + 0.1,
      boot,
    );
    expect(result.stdout).toContain('app_running=false');
    expect(tickLog).not.toMatch(/-TERM|-KILL/u);
  });

  it('确实是本仓库的开发服务器时，才按进程组发 TERM 并清掉 pid 文件', () => {
    const dir = tempDir('hs-up-a9-legit-');
    const { result, tickLog } = runStop(
      dir,
      {
        cmdline: ['pnpm', 'dev'],
        cwd: path.join(dir, 'app-local'),
        startEpoch: pidFileEpoch - 1,
      },
      pidFileEpoch,
      boot,
    );
    expect(result.stdout).toContain('app_running=true');
    expect(tickLog).toContain('-TERM -- -424242');
    expect(tickLog).not.toMatch(/-KILL/u);
    expect(result.stdout).toContain('pidfile=no');
  });
});
