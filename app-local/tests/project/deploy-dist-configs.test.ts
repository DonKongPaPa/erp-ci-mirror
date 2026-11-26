import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R-053 第一片：部署产物的自检清单，以及两份无密钥配置样例的静态边界。
 *
 * 文本形态用静态断言守；允许清单是否真的拦未知顶层目录，另有一条行为测试临时打包调用自检脚本。
 * 真正跑构建的证据在交付里贴出来，这里不构建产物。
 */

const appRoot = path.resolve(
  fileURLToPath(new URL('.', import.meta.url)),
  '../..',
);
const repoRoot = path.resolve(appRoot, '..');

const configFiles = [
  'config.example.yml',
  'config.test.example.yml',
  'config.prod.example.yml',
];

function readConfig(name: string): string {
  return readFileSync(path.join(appRoot, name), 'utf8');
}

/** 去掉注释与空行，避免注释里说明「不许写 devTools」被当成真的写了。 */
function activeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/#.*$/, '').trimEnd())
    .filter((line) => line.trim() !== '');
}

// 密钥形状在代码里拼出来，测试文件自身不命中任何一条。
const SECRET_SHAPES = [
  ['64 位十六进制主密钥', '[0-9a-fA-F]' + '{64}'],
  ['OpenAI 风格密钥', 'sk-' + '[A-Za-z0-9_-]{20,}'],
  ['GitHub 个人令牌', 'gh[pousr]_' + '[A-Za-z0-9]{20,}'],
  ['AWS 访问键', 'AKIA' + '[0-9A-Z]{16}'],
  ['私钥文件头', '-----BEGIN ' + '[A-Z ]*' + 'PRIVATE KEY-----'],
];

const FORBIDDEN = [
  'config.yml',
  "'.env*'",
  '.local',
  'tests',
  'HANDOFF',
  'raw',
  'wiki',
  '.git',
  '.ci',
];

describe('R-053 部署产物与两套配置', () => {
  it('prod 样例不启用 devTools，也不带 auth.hooks', () => {
    const lines = activeLines(readConfig('config.prod.example.yml'));
    expect(
      lines.filter((line) => /^devTools\s*:/u.test(line)),
      'prod 样例里不能出现 devTools 配置节；开着它但 NODE_ENV 不是 development，应用按设计拒绝启动。',
    ).toEqual([]);
    expect(
      lines.filter((line) => /^\s*hooks\s*:/u.test(line)),
      'hooks 由框架自己的守护占用，任何写法都会让应用拒绝启动。',
    ).toEqual([]);
  });

  it('三份样例配置里没有真实密钥的形状', () => {
    for (const name of configFiles) {
      const text = readConfig(name);
      for (const [label, shape] of SECRET_SHAPES) {
        expect(
          new RegExp(shape, 'u').test(text),
          `${name} 出现了${label}：样例里只留环境变量名，不写密钥本体。`,
        ).toBe(false);
      }
    }
  });

  it('自检脚本的禁止清单覆盖约定的每一项', () => {
    const source = readFileSync(
      path.join(repoRoot, 'scripts', 'release', 'check-dist.sh'),
      'utf8',
    );
    const block = source.match(/FORBIDDEN_TOP_LEVEL=\(\n([\s\S]*?)\n\)/u)?.[1];
    expect(block, 'check-dist.sh 里找不到 FORBIDDEN_TOP_LEVEL 数组').toBeDefined();
    for (const item of FORBIDDEN) {
      expect(block, `禁止清单少了 ${item}`).toContain(item);
    }
  });

  it('产物根出现约定外且不在禁止清单里的目录时，自检按「不在允许清单」失败', () => {
    // 行为测试：仅改文本清单不足以拦未知条目，必须让 check-dist.sh 真跑一遍。
    // 所有路径从测试文件位置和系统临时目录推出，调用方 cwd 换成临时目录，测试可从仓库任何位置跑。
    const work = mkdtempSync(path.join(tmpdir(), 'deploy-allowlist-'));
    try {
      const tree = path.join(work, 'tree');
      mkdirSync(path.join(tree, 'dist'), { recursive: true });
      for (const name of [
        'config.example.yml',
        'Dockerfile',
        'Dockerfile.dockerignore',
      ]) {
        writeFileSync(path.join(tree, name), 'fixture\n');
      }
      // 既不在允许清单、也不在 FORBIDDEN_TOP_LEVEL 里，只能靠允许清单拦。
      mkdirSync(path.join(tree, 'stray-dir'), { recursive: true });

      const artifact = path.join(work, 'artifact.tar.gz');
      const packed = spawnSync('tar', ['-czf', artifact, '-C', tree, '.']);
      expect(packed.status).toBe(0);

      const checker = path.join(repoRoot, 'scripts', 'release', 'check-dist.sh');
      const result = spawnSync('bash', [checker, artifact], {
        cwd: work,
        encoding: 'utf8',
      });
      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).not.toBe(0);
      // 未知顶层条目必须由允许清单拒绝，而不是被禁止清单漏过后放行。
      expect(output).toContain('不在允许清单');
      expect(output).toContain('stray-dir');
    } finally {
      // 只清自己建的这一个临时目录，成功与失败路径都清。
      rmSync(work, { recursive: true, force: true });
    }
  });
});
