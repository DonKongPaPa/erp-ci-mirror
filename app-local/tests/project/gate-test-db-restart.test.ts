import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { loadTestDatabaseEnv } from '../setup/test-db-env';

const repoRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const scripts = path.join(repoRoot, 'scripts', 'ci');
const checkScript = path.join(scripts, 'test-db-restart-check.sh');
const preCheckScript = path.join(scripts, 'test-pg-check.sh');
const stateScript = path.join(scripts, 'test-db-state.sh');
const verdictScript = path.join(scripts, 'verdict.mjs');
const tmpDirs: string[] = [];

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'r059-gate-'));
  tmpDirs.push(dir);
  return dir;
}

/**
 * 假探针：第 n 次调用把 values[n] 写进 PG_PROBE_START_TIME_FILE，不连真库。
 */
function fakeProbe(dir: string, values: readonly string[]): string {
  const valuesDir = path.join(dir, 'values');
  mkdirSync(valuesDir, { recursive: true });
  for (const [index, value] of values.entries()) {
    writeFileSync(path.join(valuesDir, `${index}.txt`), `${value}\n`);
  }
  const script = path.join(dir, 'fake-probe.sh');
  writeFileSync(
    script,
    [
      '#!/usr/bin/env bash',
      'set -euo pipefail',
      'n=0',
      'if [ -f "$FAKE_PROBE_COUNTER" ]; then n="$(cat "$FAKE_PROBE_COUNTER")"; fi',
      'n=$((n + 1))',
      'printf \'%s\\n\' "$n" > "$FAKE_PROBE_COUNTER"',
      'cp "$FAKE_PROBE_VALUES_DIR/$n.txt" "$PG_PROBE_START_TIME_FILE"',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  return script;
}

/** 假 podman：让 test-pg-check.sh 相信测试库容器在跑；不碰真容器。 */
function fakePodman(dir: string): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const script = path.join(bin, 'podman');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'case "$1" in',
      '  version) exit 0 ;;',
      '  ps)',
      '    if [ "$3" = \'{{.Names}}\' ]; then printf \'hs-erp-pg-test\\n\';',
      '    else printf \'hs-erp-pg-test\\tUp (healthy)\\n\'; fi',
      '    exit 0 ;;',
      '  inspect) printf \'1\\n\'; exit 0 ;;',
      '  *) exit 0 ;;',
      'esac',
    ].join('\n') + '\n',
    { mode: 0o755 },
  );
  return bin;
}

function stateEnv(dir: string, probe: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${fakePodman(dir)}:${process.env.PATH ?? ''}`,
    TEST_PG_ENV_FILE: path.join(dir, 'test-pg.env'),
    TEST_DB_STARTED_AT_FILE: path.join(dir, 'started-at'),
    TEST_DB_AFTER_FILE: path.join(dir, 'after'),
    TEST_DB_RESTARTED_FILE: path.join(dir, 'restarted'),
    PG_PROBE_BIN: probe,
    FAKE_PROBE_VALUES_DIR: path.join(dir, 'values'),
    FAKE_PROBE_COUNTER: path.join(dir, 'count'),
    TEST_DB_CHECKED: '1',
  };
}

function writeBadEnv(env: NodeJS.ProcessEnv): void {
  writeFileSync(
    env.TEST_PG_ENV_FILE as string,
    'POSTGRES_HOST=127.0.0.1\nPOSTGRES_PORT=1\nPOSTGRES_USER=hs\nPOSTGRES_PASSWORD=wrong\nPOSTGRES_DATABASE=hs\n',
  );
}

function run(script: string, env: NodeJS.ProcessEnv, args: readonly string[] = []) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env });
}

function runVerdict(dir: string, env: NodeJS.ProcessEnv) {
  const out = path.join(dir, 'verdict.json');
  const result = spawnSync(
    'node',
    [
      verdictScript,
      '--stage', 'docs',
      '--out', out,
      '--result', 'test=passed:1',
      '--result', 'evidence=passed:1',
      '--result', 'compliance=passed:1',
    ],
    { encoding: 'utf8', env },
  );
  expect(result.status, `判据脚本异常退出：${result.stderr}`).toBe(0);
  return JSON.parse(readFileSync(out, 'utf8')) as {
    testDb?: { startedAt: string; restartedDuringRun: boolean | null };
  };
}

const before = '2026-11-26T12:00:00.000Z';
const after = '2026-11-26T12:00:19.000Z';
const warning = '测试库在运行期间重启过（崩溃恢复）';

describe('R-059 测试库启动时刻与重启提示', () => {
  it('前后一致：不打印重启提示，标记 0', () => {
    const dir = tempDir();
    const env = stateEnv(dir, fakeProbe(dir, ['unused', before, before]));
    writeFileSync(env.TEST_DB_STARTED_AT_FILE as string, `${before}\n`);
    const result = run(checkScript, env);
    expect(result.status, `复核脚本异常退出：${result.stderr}`).toBe(0);
    expect(result.stdout + result.stderr).not.toContain(warning);
    expect(readFileSync(env.TEST_DB_RESTARTED_FILE as string, 'utf8').trim()).toBe('0');
  });

  it('前后不一致：打印重启提示，标记 1，退出码仍为 0', () => {
    const dir = tempDir();
    const env = stateEnv(dir, fakeProbe(dir, ['unused', after]));
    writeFileSync(env.TEST_DB_STARTED_AT_FILE as string, `${before}\n`);
    const result = run(checkScript, env);
    expect(result.status, `复核脚本异常退出：${result.stderr}`).toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain(warning);
    expect(output).toContain('was terminated by signal');
    expect(readFileSync(env.TEST_DB_RESTARTED_FILE as string, 'utf8').trim()).toBe('1');
  });

  it('读不到时刻写 null 并提示「没能复核」，退出码仍为 0', () => {
    const dir = tempDir();
    const env = stateEnv(dir, fakeProbe(dir, ['unused', before]));
    writeFileSync(env.TEST_DB_STARTED_AT_FILE as string, '');
    const result = run(checkScript, env);
    expect(result.status, `复核脚本异常退出：${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('没能复核测试库是否重启');
    expect(readFileSync(env.TEST_DB_RESTARTED_FILE as string, 'utf8').trim()).toBe('null');
    const verdict = runVerdict(dir, env);
    expect(verdict.testDb?.restartedDuringRun).toBeNull();
  });

  it('复核探针失败同样写 null 并提示', () => {
    const dir = tempDir();
    const failed = path.join(dir, 'failing-probe.sh');
    writeFileSync(failed, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const env = stateEnv(dir, failed);
    writeFileSync(env.TEST_DB_STARTED_AT_FILE as string, `${before}\n`);
    const result = run(checkScript, env);
    expect(result.status, `复核脚本异常退出：${result.stderr}`).toBe(0);
    expect(result.stderr).toContain('没能复核测试库是否重启');
    expect(readFileSync(env.TEST_DB_RESTARTED_FILE as string, 'utf8').trim()).toBe('null');
  });

  it('判据只在核对过时写 testDb，且 restartedDuringRun 为三态', () => {
    const dir = tempDir();
    const env = stateEnv(dir, fakeProbe(dir, ['unused', before]));
    writeFileSync(env.TEST_DB_STARTED_AT_FILE as string, `${before}\n`);
    writeFileSync(env.TEST_DB_RESTARTED_FILE as string, '1\n');
    expect(runVerdict(dir, env).testDb).toEqual({
      startedAt: before,
      restartedDuringRun: true,
    });
    // 没核对过：即使旧文件还在，也不能带进判据。
    const stale = runVerdict(dir, { ...env, TEST_DB_CHECKED: '0' });
    expect(stale.testDb).toBeUndefined();
  });

  it('不核对的档位清掉上一轮的三个时刻文件', () => {
    const dir = tempDir();
    const env = stateEnv(dir, fakeProbe(dir, ['unused', before]));
    for (const key of ['TEST_DB_STARTED_AT_FILE', 'TEST_DB_AFTER_FILE', 'TEST_DB_RESTARTED_FILE'] as const) {
      writeFileSync(env[key] as string, 'stale\n');
    }
    const result = run(stateScript, { ...env, TEST_DB_CHECKED: '0' }, ['clear']);
    expect(result.status, `清理脚本异常退出：${result.stderr}`).toBe(0);
    for (const key of ['TEST_DB_STARTED_AT_FILE', 'TEST_DB_AFTER_FILE', 'TEST_DB_RESTARTED_FILE'] as const) {
      expect(existsSync(env[key] as string), `${key} 没清掉`).toBe(false);
    }
    // 清掉之后即使判据被误调用，也不会写 testDb。
    expect(runVerdict(dir, { ...env, TEST_DB_CHECKED: '0' }).testDb).toBeUndefined();
  });

  it('前置核对真的执行：时刻落盘、复核读回一致（假容器 + 替身探针）', () => {
    const dir = tempDir();
    const env = stateEnv(dir, fakeProbe(dir, ['unused', before, before]));
    writeBadEnv(env);
    const pre = run(preCheckScript, env);
    expect(pre.status, `前置核对异常退出：${pre.stderr}`).toBe(0);
    expect(pre.stdout + pre.stderr).not.toContain('连不上');
    expect(readFileSync(env.TEST_DB_STARTED_AT_FILE as string, 'utf8').trim()).toBe(before);
    const post = run(checkScript, env);
    expect(post.status, `复核脚本异常退出：${post.stderr}`).toBe(0);
    expect(readFileSync(env.TEST_DB_RESTARTED_FILE as string, 'utf8').trim()).toBe('0');
    expect(post.stdout + post.stderr).not.toContain(warning);
  });

  // docs / 只改文档的 fast 不连库；这条只在真连库的档位验真探针落盘。
  it.skipIf(process.env.NOCOBASE_DOCS_ONLY === '1')(
    '真探针连上测试库时把启动时刻写进文件（不是只靠替身）',
    () => {
      const dir = tempDir();
      const env = { ...process.env } as Record<string, string | undefined>;
      loadTestDatabaseEnv(env, repoRoot);
      expect(env.POSTGRES_HOST, '这条用例需要连得到测试库').toBeTruthy();
      const target = path.join(dir, 'started-at');
      const result = spawnSync('node', [path.join(scripts, 'pg-probe.mjs')], {
        encoding: 'utf8',
        env: { ...env, PG_PROBE_START_TIME_FILE: target } as NodeJS.ProcessEnv,
      });
      expect(result.status, `真探针异常退出：${result.stderr}`).toBe(0);
      expect(readFileSync(target, 'utf8').trim()).toMatch(/^\d{4}-\d{2}-\d{2}T/u);
    },
  );

  it('同副本并发的另一个档位开工，不会清掉本轮前置时刻，也不会误判成没重启', () => {
    const dir = tempDir();
    const initA = spawnSync('bash', [stateScript, 'init', dir], { encoding: 'utf8' });
    const initB = spawnSync('bash', [stateScript, 'init', dir], { encoding: 'utf8' });
    expect(initA.status, `A 档位 init 失败：${initA.stderr}`).toBe(0);
    expect(initB.status, `B 档位 init 失败：${initB.stderr}`).toBe(0);
    const runA = initA.stdout.trim();
    const runB = initB.stdout.trim();
    expect(runA, '两次开工必须拿到不同目录').not.toBe(runB);
    expect(runA).toContain('/test-db-run.');

    const envA = stateEnv(runA, fakeProbe(runA, ['unused', after]));
    const envB = stateEnv(runB, fakeProbe(runB, ['unused', before]));
    writeFileSync(envA.TEST_DB_STARTED_AT_FILE as string, `${before}\n`);
    writeFileSync(envB.TEST_DB_STARTED_AT_FILE as string, `${before}\n`);

    // 另一个档位「开工」只清自己的目录，不能动到 A 的前置时刻。
    const cleared = spawnSync('bash', [stateScript, 'clear'], {
      encoding: 'utf8',
      env: envB,
    });
    expect(cleared.status, `B 档位清理失败：${cleared.stderr}`).toBe(0);
    expect(
      readFileSync(envA.TEST_DB_STARTED_AT_FILE as string, 'utf8').trim(),
      '另一档位开工把本轮前置时刻清掉了',
    ).toBe(before);

    const result = run(checkScript, envA);
    expect(result.status, `复核脚本异常退出：${result.stderr}`).toBe(0);
    expect(result.stdout + result.stderr, '重启过却没提示').toContain(warning);
    expect(
      readFileSync(envA.TEST_DB_RESTARTED_FILE as string, 'utf8').trim(),
      '重启过却写成没重启或没法判断',
    ).toBe('1');
  });

  it('闸门只在核对过的档位复核，档位逻辑未改', () => {
    const probe = readFileSync(path.join(scripts, 'pg-probe.mjs'), 'utf8');
    expect(probe).toContain('pg_postmaster_start_time()');
    expect(probe).toContain('PG_PROBE_START_TIME_FILE');
    const gate = readFileSync(path.join(scripts, 'gate.sh'), 'utf8');
    expect(gate).toContain('unit|beta|all) need_test_db=1');
    expect(gate).toContain('test-db-state.sh" init "$CI_DIR"');
    expect(gate).toContain('cleanup_test_db_run');
    expect(gate).not.toContain('test-db-state.sh" clear');
    expect(gate).toContain('TEST_DB_CHECKED=1');
    expect(gate).toMatch(
      /if \[ "\$TEST_DB_CHECKED" -eq 1 \]; then[\s\S]*test-db-restart-check\.sh/u,
    );
  });
});
