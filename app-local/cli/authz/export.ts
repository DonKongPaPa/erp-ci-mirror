import { writeFile } from 'node:fs/promises';

import { AppCommand, appPath } from '@nocobase/app-cli';

import {
  collectAuthorizationExport,
  type AuthorizationApis,
  type ExportSummary,
} from './transfer.js';

interface ExportResult extends ExportSummary {
  file: string;
}

/**
 * `pnpm nocobase authz export --out <文件>`。
 *
 * 导出四部分：角色定义（带版本号）、赋权（普通账号按用户名，服务账号按名字）、
 * 三类规则、受保护标记。走服务层，不走 HTTP：命令行里没有权限门。应用要先起起来
 * —— 本应用的 FQC 业务资源在 provider 的 `boot()` 里注册，不启动就校验不了复合授权。
 */
export default class AuthzExport extends AppCommand {
  static summary =
    'Export permission sets, assignments, rules and protections as JSON.';
  static description =
    'Writes the four parts of the permission model — permission sets with their revisions, assignments by username (service accounts by name), the three rule kinds and the protected markers — so another environment can import them. Rules carry their subjects in the same cross-environment form. Reads through the authorization services, never HTTP. Starts the application, so pending migrations and seeds run first.';
  static examples = [
    '<%= config.bin %> <%= command.id %> --out ./authorization.json',
    '<%= config.bin %> <%= command.id %> --out ./authorization.json --json',
  ];
  static flags = {
    out: appPath({
      required: true,
      description: 'The JSON file to write.',
    }),
  };

  async run(): Promise<ExportResult> {
    const { flags } = await this.parse(AuthzExport);
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
      const { file, summary } = await collectAuthorizationExport(
        authz,
        database,
      );
      await writeFile(flags.out, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
      return { file: flags.out, ...summary };
    });
    this.log(
      `Exported ${result.permissionSets} permission sets, ${result.assignments} assignments, ` +
        `${result.defaultAccess} default-access rules, ${result.sharing} sharing rules, ` +
        `${result.restriction} restriction rules and ${result.protected} protections to ${result.file}.`,
    );
    return result;
  }
}
