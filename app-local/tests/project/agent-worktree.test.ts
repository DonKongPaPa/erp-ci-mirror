import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const scriptSource = path.resolve(
  import.meta.dirname,
  '../../../scripts/dev/agent-worktree.sh',
);

const workspaces: string[] = [];

afterEach(async () => {
  for (const workspace of workspaces.splice(0)) {
    await rm(workspace, { recursive: true, force: true });
  }
});

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** 跑一条命令，原样交回退出码与输出；命令起不来是测试环境的问题，直接判失败。 */
function run(command: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8' });
  expect(result.error, `${command} 起不来：${result.error?.message ?? ''}`).toBeUndefined();
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 跑一条必须成功的命令，返回合并后的输出。 */
function ok(command: string, args: string[], cwd: string): string {
  const result = run(command, args, cwd);
  expect(
    result.status,
    `${command} ${args.join(' ')} 失败：\n${result.stdout}${result.stderr}`,
  ).toBe(0);
  return result.stdout + result.stderr;
}

/**
 * 在临时目录里造一个小仓库，把脚本拷进去。
 *
 * 脚本把副本放在 /tmp/hs-wt-<名字>：这里只把那一行路径模板改到临时目录里，
 * 剩下的 create / remove 逻辑原样执行，不碰真实的仓库与别人的副本。
 */
async function fixture(withSkills: boolean) {
  const workspace = await mkdtemp(path.join(tmpdir(), 'hs-wt-e2e-'));
  workspaces.push(workspace);
  const repo = path.join(workspace, 'repo');
  await mkdir(repo);
  ok('git', ['init', '-q', '-b', 'main'], repo);
  ok('git', ['config', 'user.email', 'e2e@agents.invalid'], repo);
  ok('git', ['config', 'user.name', 'e2e'], repo);
  // 真仓库里 app-local 是入库的，副本才有这一层目录可以放软链。
  await mkdir(path.join(repo, 'app-local', '.agents', 'rules'), {
    recursive: true,
  });
  await writeFile(path.join(repo, 'app-local', '.gitkeep'), 'keep\n');
  await writeFile(
    path.join(repo, 'app-local', '.agents', 'rules', 'keep'),
    'keep\n',
  );
  ok(
    'git',
    ['add', '-f', 'app-local/.gitkeep', 'app-local/.agents/rules/keep'],
    repo,
  );
  ok('git', ['commit', '-q', '-m', 'init'], repo);
  // 清掉分支 ref 之后这些文件会变成未跟踪；排除掉它们，副本才保持干净。
  await writeFile(
    path.join(repo, '.git', 'info', 'exclude'),
    'app-local/.gitkeep\napp-local/.agents/rules/keep\n',
  );
  await mkdir(path.join(repo, 'app-local', 'node_modules'));
  if (withSkills) {
    await mkdir(path.join(repo, 'app-local', '.agents', 'skills'), {
      recursive: true,
    });
  }

  const source = await readFile(scriptSource, 'utf8');
  const patched = source.replace(
    "printf '/tmp/hs-wt-%s'",
    `printf '${path.join(workspace, 'hs-wt-%s')}'`,
  );
  expect(
    patched,
    '脚本里 worktree_path 的写法变了，测试的隔离补丁没生效。',
  ).not.toBe(source);
  const script = path.join(repo, 'agent-worktree.sh');
  await writeFile(script, patched, { mode: 0o755 });

  const name = path.basename(workspace).toLowerCase();
  return { workspace, repo, script, name, wt: path.join(workspace, `hs-wt-${name}`) };
}

describe('agent-worktree.sh（R-043）', () => {
  it('chains both generated directories on create and tolerates an already collected copy on remove', async () => {
    const f = await fixture(true);
    expect(
      ok(f.script, ['create', f.name, 'implementer', 'deepseek-v4.1-flash'], f.repo),
    ).toContain(f.wt);

    for (const [link, target] of [
      [
        path.join(f.wt, 'app-local', 'node_modules'),
        path.join(f.repo, 'app-local', 'node_modules'),
      ],
      [
        path.join(f.wt, 'app-local', '.agents', 'skills'),
        path.join(f.repo, 'app-local', '.agents', 'skills'),
      ],
    ]) {
      expect((await lstat(link)).isSymbolicLink(), `${link} 不是软链`).toBe(true);
      expect(await readlink(link)).toBe(target);
    }
    // 两个软链都是生成物，副本开出来必须是干净的。
    expect(ok('git', ['-C', f.wt, 'status', '--porcelain'], f.repo)).toBe('');

    // gh pr merge --delete-branch 的真实顺序（v2.104.0）：分支被另一个副本占用时，
    // 它先收掉这个副本、再删分支。再跑 remove 时三样都不在了，要能正常收尾。
    const branch = `agent/implementer/${f.name}`;
    ok('git', ['worktree', 'remove', f.wt], f.repo);
    ok('git', ['update-ref', '-d', `refs/heads/${branch}`], f.repo);
    const removed = ok(f.script, ['remove', f.name, '--delete-branch'], f.repo);
    expect(removed).toContain('副本与本地分支都已不存在');
    expect(removed).not.toContain('看用法');
    expect(existsSync(f.wt)).toBe(false);
  });

  it('still refuses when an unregistered copy leaves its directory or branch behind', async () => {
    const collected = async () => {
      const f = await fixture(true);
      ok(f.script, ['create', f.name, 'implementer', 'deepseek-v4.1-flash'], f.repo);
      ok('git', ['worktree', 'remove', f.wt], f.repo);
      return f;
    };

    // 分支还在：照旧拒绝，不当成「已经收掉」。
    const branchLeft = await collected();
    expect(
      run(
        branchLeft.script,
        ['remove', branchLeft.name, '--delete-branch'],
        branchLeft.repo,
      ).status,
    ).not.toBe(0);

    // 目录还在：照旧拒绝，而且不替别人删那个目录。
    const dirLeft = await collected();
    await mkdir(dirLeft.wt);
    expect(
      run(dirLeft.script, ['remove', dirLeft.name, '--delete-branch'], dirLeft.repo)
        .status,
    ).not.toBe(0);
    expect(existsSync(dirLeft.wt)).toBe(true);
  });

  it('explains how to generate the skills directory when the main checkout lacks it', async () => {
    const f = await fixture(false);
    const result = run(
      f.script,
      ['create', f.name, 'implementer', 'deepseek-v4.1-flash'],
      f.repo,
    );
    expect(result.status, '主检出缺生成物时 create 应该失败').not.toBe(0);
    const output = result.stdout + result.stderr;
    expect(output).toContain('app-local/.agents/skills');
    expect(output).toContain('pnpm install');
    // 前置条件不满足时不能先开出半个副本。
    expect(existsSync(f.wt)).toBe(false);
  });
});
