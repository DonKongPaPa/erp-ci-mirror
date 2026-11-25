import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../../..',
);
const workflowDir = path.join(repoRoot, '.github', 'workflows');

/**
 * GitHub Actions 遇到重复映射键会拒绝运行整份 workflow，而报错只有一句
 * 「This run likely failed because of a workflow file issue」；
 * 本地多数 YAML 解析器会静默取后一个值 —— 所以这类错误只在推上去才暴露。
 *
 * 真实踩过（2026-11-23）：给 beta job 加 `timeout-minutes: 25` 时忘了删原有的 60，
 * 两个键并存，推送后整个 run 直接失败，连 job 都没创建。
 *
 * 这条测试用 python 的 PyYAML 加自定义 loader 检测重复键 —— 手写行扫描会误报
 * （step 列表里相邻项都有 `with:` / `run:`，那是不同列表项，不是重复键）。
 */
const DUPLICATE_KEY_CHECK = `
import sys, yaml

class StrictLoader(yaml.SafeLoader):
    pass

def construct_mapping(loader, node, deep=False):
    keys = set()
    for key_node, _ in node.value:
        key = loader.construct_object(key_node, deep=deep)
        if key in keys:
            raise ValueError(f"duplicate key: {key}")
        keys.add(key)
    return yaml.SafeLoader.construct_mapping(loader, node, deep)

StrictLoader.add_constructor(
    yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, construct_mapping
)

for path in sys.argv[1:]:
    try:
        with open(path, encoding="utf-8") as handle:
            yaml.load(handle, Loader=StrictLoader)
    except ValueError as error:
        print(f"{path}: {error}")
`;

function duplicateKeyFindings(files: string[]): string[] {
  if (files.length === 0) {
    return [];
  }
  try {
    const stdout = execFileSync(
      'python3',
      ['-I', '-c', DUPLICATE_KEY_CHECK, ...files],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => line.replace(`${workflowDir}/`, ''));
  } catch (error) {
    const failure = error as { stderr?: string };
    // python3 或 PyYAML 不可用时跳过而不是失败：这条检查是附加保险，不是主闸门。
    if ((failure.stderr ?? '').includes('ModuleNotFoundError')) {
      return [];
    }
    throw error;
  }
}

describe('GitHub Actions workflow', () => {
  const files = existsSync(workflowDir)
    ? readdirSync(workflowDir)
        .filter((name) => /\.ya?ml$/u.test(name))
        .map((name) => path.join(workflowDir, name))
    : [];

  it('has at least one workflow', () => {
    expect(files.length, 'workflow 目录下没有 YAML 文件。').toBeGreaterThan(0);
  });

  it('has no duplicate mapping keys', () => {
    const problems = duplicateKeyFindings(files);
    expect(
      problems,
      `workflow 里有重复键，GitHub 会拒绝运行整份文件：${problems.join('；')}`,
    ).toEqual([]);
  });

  it('does not skip markdown changes', () => {
    // 八个守门测试查的正是 md。跳过 md 等于让文档纪律在 CI 上永不执行。
    // 只看真实配置，注释里提到 paths-ignore 是允许的（那里写着为什么不加）。
    const offenders = files.filter((file) => {
      const contents = readFileSync(file, 'utf8');
      return contents
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('#'))
        .some((line) => line.includes('paths-ignore'));
    });
    expect(
      offenders.map((file) => path.basename(file)),
      'workflow 的 paths-ignore 会跳过 md 改动，使文档守门在 CI 上永不执行。',
    ).toEqual([]);
  });
});

/**
 * R-039 验收 8：按需对一个分支跑端到端。
 *
 * 用 PyYAML 解析后的结构断言，不在原文里找字符串 —— 注释里提到同样的
 * 字面量不算数；重复键也另有一条测试守着（GitHub 遇到重复键会拒绝整份文件）。
 */
const DISPATCH_SUMMARY = `
import json, sys, yaml
doc = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
# PyYAML 按 YAML 1.1 把 on 解析成布尔 True，两种键都要认。
triggers = doc.get('on')
if triggers is None:
    triggers = doc.get(True)
triggers = triggers or {}
dispatch = triggers.get('workflow_dispatch')
dispatch = dispatch if isinstance(dispatch, dict) else {}
inputs = dispatch.get('inputs')
inputs = inputs if isinstance(inputs, dict) else {}
definition = inputs.get('run_e2e')
definition = definition if isinstance(definition, dict) else None
beta = (doc.get('jobs') or {}).get('beta') or {}
push = triggers.get('push')
push = push if isinstance(push, dict) else {}
result = {
    'has_input': definition is not None,
    'type': definition.get('type') if definition else None,
    'default': definition.get('default') if definition else None,
    'beta_if': beta.get('if'),
    'push_branches': push.get('branches'),
}
print(json.dumps(result, ensure_ascii=False))
`;

type DispatchSummary = {
  has_input: boolean;
  type: string | null;
  default: boolean | string | null;
  beta_if: string | null;
  push_branches: string[] | null;
};

function dispatchSummary(): DispatchSummary | null {
  try {
    const stdout = execFileSync(
      'python3',
      ['-I', '-c', DISPATCH_SUMMARY, path.join(workflowDir, 'gate.yml')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(stdout) as DispatchSummary;
  } catch (error) {
    // 与重复键检查一致：python3 或 PyYAML 不可用时跳过这条附加检查。
    if ((error as { stderr?: string }).stderr?.includes('ModuleNotFoundError')) {
      return null;
    }
    throw error;
  }
}

const summary = dispatchSummary();

describe.skipIf(summary === null)('按需对一个分支跑端到端（R-039 验收 8）', () => {
  const parsed = summary as DispatchSummary;

  it('workflow_dispatch 有布尔输入 run_e2e，默认 false', () => {
    expect(parsed.has_input, 'workflow_dispatch.inputs 里没有 run_e2e。').toBe(true);
    expect(parsed.type, 'run_e2e 必须是 boolean 输入。').toBe('boolean');
    expect(
      parsed.default,
      'run_e2e 默认必须是布尔 false，不是字符串 false。',
    ).toBe(false);
  });

  it('beta 保留自动触发的原条件，并放行手动点名', () => {
    const condition = parsed.beta_if ?? '';
    // 推送与 pr/** 的自动行为不变：原来的两个条件一个字不能丢。
    expect(condition).toContain("needs.changes.outputs.docs_only != 'true'");
    expect(condition).toContain("github.ref == 'refs/heads/main'");
    // 手动触发且打开开关时任意分支都跑 —— 人点名要跑就照跑，连「只改文档不跑」也例外。
    expect(condition).toContain("github.event_name == 'workflow_dispatch'");
    expect(condition).toContain('inputs.run_e2e');
    expect(parsed.push_branches).toContain('main');
    expect(parsed.push_branches).toContain('pr/**');
  });
});

/**
 * 「改动范围」那一步的判定脚本要拿真的提交跑一遍（2026-11-25 踩过）。
 *
 * 仓库里的文档全在中文目录下。Git 默认把这种路径输出成带引号的八进制转义
 * （`"wiki/\\351\\241\\271…"`），开头的引号让「是不是文档」落空 —— 文档快道对真实提交
 * 一次都不会生效，而实现时是在临时仓库里用英文名的文件测的，所以没发现。
 * 这里把脚本从 workflow 里原样取出来，在一个带中文路径的临时仓库里按几种事件各跑一遍。
 */
const CLASSIFY_SCRIPT = `
import json, sys, yaml
doc = yaml.safe_load(open(sys.argv[1], encoding="utf-8"))
steps = doc["jobs"]["changes"]["steps"]
print(json.dumps(next(step for step in steps if step.get("id") == "classify")["run"]))
`;

function classifyScript(): string | null {
  try {
    const stdout = execFileSync(
      'python3',
      ['-I', '-c', CLASSIFY_SCRIPT, path.join(workflowDir, 'gate.yml')],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    );
    return JSON.parse(stdout) as string;
  } catch (error) {
    // python3 或 PyYAML 不可用时跳过而不是失败，与上面查重复键的思路一致。
    if ((error as { stderr?: string }).stderr?.includes('ModuleNotFoundError'))
      return null;
    throw error;
  }
}

const classifyScriptText = (() => {
  try {
    return classifyScript();
  } catch {
    return null;
  }
})();

function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function runClassify(
  cwd: string,
  script: string,
  env: Record<string, string>,
): string {
  // 四个变量在 workflow 里总是设着的（没有的那两个是空串），这里照办。
  const output = path.join(cwd, 'output.txt');
  // 脚本是往 GITHUB_OUTPUT 里追加的；同一个仓库里要跑好几次，每次从空文件开始。
  rmSync(output, { force: true });
  execFileSync('bash', [script], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      // 镜像仓库把 CI_MIRROR 设在整个作业的环境里；分类脚本的测试要与它隔离，否则一律判成「不是只改文档」
      CI_MIRROR: '',
      EVENT_NAME: '',
      PUSH_BEFORE: '',
      PUSH_HEAD: '',
      PR_BASE: '',
      PR_HEAD: '',
      ...env,
      GITHUB_OUTPUT: output,
    },
  });
  return readFileSync(output, 'utf8').trim();
}

describe.skipIf(!existsSync('/bin/bash') || classifyScriptText === null)(
  'docs fast path classification',
  () => {
    it('recognises docs-only changes even when the paths are not ASCII', () => {
      const repo = mkdtempSync(path.join(tmpdir(), 'gate-classify-'));
      try {
        const script = path.join(repo, 'classify.sh');
        writeFileSync(script, classifyScriptText as string);
        gitIn(repo, 'init', '--quiet');
        gitIn(repo, 'config', 'user.name', 'Gate Classify Test');
        gitIn(repo, 'config', 'user.email', 'gate-classify@example.com');
        gitIn(repo, 'config', 'commit.gpgsign', 'false');
        const doc = path.join(repo, 'wiki', '项目决策', '需求', '需求池.md');
        const code = path.join(repo, 'app-local', 'a.ts');
        mkdirSync(path.dirname(doc), { recursive: true });
        mkdirSync(path.dirname(code), { recursive: true });
        writeFileSync(doc, '# 需求池\n');
        writeFileSync(code, 'export const a = 1;\n');
        gitIn(repo, 'add', '.');
        gitIn(repo, 'commit', '--quiet', '-m', 'first');
        const first = gitIn(repo, 'rev-parse', 'HEAD');
        writeFileSync(doc, '# 需求池\n第二批\n');
        gitIn(repo, 'add', '.');
        gitIn(repo, 'commit', '--quiet', '-m', 'docs only');
        const second = gitIn(repo, 'rev-parse', 'HEAD');
        writeFileSync(code, 'export const a = 2;\n');
        gitIn(repo, 'add', '.');
        gitIn(repo, 'commit', '--quiet', '-m', 'code');
        const third = gitIn(repo, 'rev-parse', 'HEAD');

        const run = (env: Record<string, string>) =>
          runClassify(repo, script, env);
        expect(
          run({ EVENT_NAME: 'push', PUSH_BEFORE: first, PUSH_HEAD: second }),
          '只改了中文目录下的文档，应当判成「只改了文档」',
        ).toBe('docs_only=true');
        expect(
          run({ EVENT_NAME: 'push', PUSH_BEFORE: second, PUSH_HEAD: third }),
        ).toBe('docs_only=false');
        expect(
          run({
            EVENT_NAME: 'pull_request',
            PR_BASE: first,
            PR_HEAD: second,
          }),
        ).toBe('docs_only=true');
        expect(
          run({
            EVENT_NAME: 'push',
            PUSH_BEFORE: '0'.repeat(40),
            PUSH_HEAD: second,
          }),
          '基线是全零（新分支或强推）要按全量处理',
        ).toBe('docs_only=false');
      } finally {
        rmSync(repo, { recursive: true, force: true });
      }
    });
  },
);
