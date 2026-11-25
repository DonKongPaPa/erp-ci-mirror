import { readFile } from 'node:fs/promises';

import { AppCommand, CommandError, appPath } from '@nocobase/app-cli';

import { parseAuthorizationExport } from './format.js';
import {
  applyAuthorizationImport,
  planAuthorizationImport,
  type AuthorizationApis,
  type ImportSummary,
} from './transfer.js';

interface ImportResult extends ImportSummary {
  file: string;
}

/**
 * `pnpm nocobase authz import --file <文件>`。
 *
 * 先校验、全部通过才写授权数据。服务层的校验不全（不查授权内容、不查用户存不存在），
 * 所以这里自己补：按用户名/服务账号名查主体、逐条 `compositeResources.validateGrant`、
 * 资源注册、规则 selection 与默认访问规则冲突、受保护标记核对。任何问题都列全再退出，
 * 授权数据一行不写（应用启动本身仍会建库、跑迁移与 seed）。
 *
 * 导入等于信任这份文件：文件可以给任何已注册的资源与动作授权，包括 root 与「用户 · 读」。
 * 成功的输出逐条列出新建与更新的条目，作为审计线索。
 *
 * 写到一半失败时停下并列出已写入与未写入的条目。不为了整批回滚绕开服务层
 * 直接写表：重跑是幂等的，这是设计接受的代价。
 */
export default class AuthzImport extends AppCommand {
  static summary = 'Import an authorization export into this environment.';
  static description =
    'Validates the whole file before writing any authorization data: every username and service-account name is looked up, every grant is checked against the registered resources, rule selections and default-access conflicts are checked, and the protected markers must match what this application declares. Any problem lists every issue and exits without writing authorization data — the application start itself may still create or migrate the database and run seeds. The import trusts the file: it can grant any registered resource and action, including root and user reads, to any account the file names. Every created and updated entry is listed at the end. A write that fails halfway stops and lists what was written and what was not. It does not roll the batch back by writing tables directly — rerunning the same file is the recovery path, and it is safe because the import is idempotent.';
  static examples = [
    '<%= config.bin %> <%= command.id %> --file ./authorization.json',
    '<%= config.bin %> <%= command.id %> --file ./authorization.json --json',
  ];
  static flags = {
    file: appPath({
      required: true,
      description: 'The JSON file to import.',
    }),
  };

  async run(): Promise<ImportResult> {
    const { flags } = await this.parse(AuthzImport);
    const document = parseAuthorizationExport(await readImportFile(flags.file));
    if (document.file === undefined) {
      throw new CommandError(
        'The file has problems; no authorization data was written.',
        {
          code: 'IMPORT_VALIDATION_FAILED',
          details: { file: flags.file, problems: document.problems },
        },
      );
    }
    const parsed = document.file;
    const result = await this.withApp(async ({ app }) => {
      await app.start();
      // 命令树在 --help 时也会全部导入，重的东西留到真正执行时再加载。
      const { authorizationToken } =
        await import('@nocobase/app-plugin-authorization/server');
      const { databaseManagerToken } = await import('@nocobase/db');
      const authz = app.container.resolve(
        authorizationToken,
      ) as AuthorizationApis;
      const database = app.container.resolve(databaseManagerToken);
      const plan = await planAuthorizationImport(authz, database, parsed);
      if (plan.problems.length > 0) {
        throw new CommandError(
          'The file has problems; no authorization data was written.',
          {
            code: 'IMPORT_VALIDATION_FAILED',
            details: { file: flags.file, problems: plan.problems },
          },
        );
      }
      const summary = await applyAuthorizationImport(plan);
      return { file: flags.file, ...summary };
    });
    this.log(
      `Imported from ${result.file}: ` +
        `permission sets (${formatCounts(result.permissionSets)}), ` +
        `assignments (${formatCounts(result.assignments)}), ` +
        `default-access rules (${formatCounts(result.defaultAccess)}), ` +
        `sharing rules (${formatCounts(result.sharing)}), ` +
        `restriction rules (${formatCounts(result.restriction)}).`,
    );
    if (result.changes.created.length > 0) {
      this.log(`Created: ${result.changes.created.join('; ')}.`);
    }
    if (result.changes.updated.length > 0) {
      this.log(`Updated: ${result.changes.updated.join('; ')}.`);
    }
    return result;
  }
}

async function readImportFile(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    throw new CommandError('The import file could not be read.', {
      code: 'INVALID_IMPORT_FILE',
      details: { file },
      cause: error,
    });
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new CommandError('The import file is not valid JSON.', {
      code: 'INVALID_IMPORT_FILE',
      details: { file },
      cause: error,
    });
  }
}

function formatCounts(counts: {
  created: number;
  updated: number;
  unchanged: number;
}): string {
  return `${counts.created} created, ${counts.updated} updated, ${counts.unchanged} unchanged`;
}
