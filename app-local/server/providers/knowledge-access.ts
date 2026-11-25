import type { AppPluginApplication } from '@nocobase/app-server/plugins';
import { authorizationToken } from '@nocobase/app-plugin-authorization/server';
import {
  knowledgeAccessToken,
  type KnowledgeAccessResolver,
  type KnowledgeReader,
} from '@nocobase/app-plugin-knowledge/server/tokens';
import {
  accessOf,
  type KnowledgeAccess,
  type KnowledgeLevel,
  type SpaceRef,
} from '@nocobase/app-plugin-knowledge/shared/knowledge';
import { databaseManagerToken } from '@nocobase/db';
import { ServiceProvider } from '@nocobase/service-provider';

/**
 * R-002：质量知识库的空间与访问解析器。
 *
 * 不绑解析器就没有空间，所以这个 provider 是本条要交付的东西，不是实现细节。
 * 知识库插件不认人也不认空间：它只问这里「这个读者在这个空间里能做什么」。答案
 * 从授权的 `kb.knowledge` 动作来 —— 应用取最高的一档再展开，因为四个档位本身是
 * 包含关系（持 `manage` 就持 `edit` / `propose` / `read`）。逐动作独立问会把一条
 * 已有的包含关系又实现一遍，而且实现错了：只持 `manage.related` 的质量主管会得到
 * `read = false`，被自己的档位挡住。
 *
 * 空间只有一个：`{ scope: 'quality', scopeId: 'standards' }`，没有继承。别的空间
 * 回空（插件回 400 `INVALID_SCOPE`）。读者不是账号时四项都是假。
 *
 * 读者：投递时是投递的服务账号，页面上手动投递时是登录的人。取姓名只读三列
 * （标识、姓名、用户名），不回邮箱（R-028 的选择性暴露）。
 */

const SPACE: SpaceRef = { scope: 'quality', scopeId: 'standards' } as const;
const SPACE_TITLE = '质量标准';

/** 从高到低：第一个持有的那一档就是读者的档位。 */
const LEVELS: readonly KnowledgeLevel[] = ['manage', 'edit', 'propose', 'read'];
/** `.related` 与 `.all` 今天等价（本应用只有一个空间），两档都要问。 */
const LEVEL_SCOPES = ['related', 'all'] as const;

const NO_ACCESS: KnowledgeAccess = {
  read: false,
  propose: false,
  edit: false,
  manage: false,
};

function isSpace(ref: SpaceRef): boolean {
  return ref?.scope === SPACE.scope && ref?.scopeId === SPACE.scopeId;
}

export default class KnowledgeAccessProvider extends ServiceProvider<AppPluginApplication> {
  readonly name = 'app.knowledge-access';

  override register(): void {
    this.app.container.singleton(knowledgeAccessToken, () => this.resolver());
  }

  private resolver(): KnowledgeAccessResolver {
    const { container } = this.app;
    const database = () =>
      container.has(databaseManagerToken)
        ? container.resolve(databaseManagerToken).connection()
        : undefined;

    /** 读者必须是一个账号（人员或服务账号）；没有这个标识就不是账号。 */
    const isAccount = async (userId: string): Promise<boolean> => {
      const connection = database();
      if (!connection || !userId) {
        return false;
      }
      const row = await connection.query
        .selectFrom('user')
        .select('id')
        .where('id', '=', userId)
        .executeTakeFirst();
      return row !== undefined;
    };

    /** 读者在这一档上持有的最高档；什么都没持有就是 none。 */
    const levelOf = async (
      userId: string,
      space: SpaceRef,
    ): Promise<KnowledgeLevel | null> => {
      if (!isSpace(space) || !(await isAccount(userId))) {
        return null;
      }
      if (!container.has(authorizationToken)) {
        return null;
      }
      const authorization = container.resolve(authorizationToken);
      const subject = { type: 'user', id: userId };
      const subjects = [
        { type: 'authenticated', id: '*' },
        ...(await authorization.subjects.resolveFor(subject)),
      ];
      const context = authorization.for({ principal: subject, subjects });
      for (const level of LEVELS) {
        for (const scope of LEVEL_SCOPES) {
          const decision = await context.authorize({
            resource: { type: 'kb', id: 'kb.knowledge' },
            action: `${level}.${scope}`,
          });
          if (decision.effect === 'permit') {
            return level;
          }
        }
      }
      return null;
    };

    return {
      space: (ref) => (isSpace(ref) ? { ...SPACE } : null),
      inherits: () => [],
      title: () => Promise.resolve(SPACE_TITLE),
      forReader: (reader: KnowledgeReader) => {
        // 同一个读者在一个请求里问多次时只算一次。
        const answers = new Map<string, Promise<KnowledgeAccess>>();
        return {
          access: (space) => {
            const key = `${space.scope}\u0000${space.scopeId}`;
            let answer = answers.get(key);
            if (!answer) {
              answer = levelOf(reader.userId, space).then((level) =>
                level === null ? NO_ACCESS : accessOf(level),
              );
              answers.set(key, answer);
            }
            return answer;
          },
        };
      },
      names: async (refs) => {
        const wanted = refs.filter((ref) => ref.kind === 'user' && ref.id);
        const ids = [...new Set(wanted.map((ref) => ref.id))];
        const names = new Map<string, string>();
        const connection = database();
        if (!connection || ids.length === 0) {
          return names;
        }
        // 只取三列：标识、姓名、用户名。不回邮箱（R-028 的选择性暴露）。
        const rows = await connection.query
          .selectFrom('user')
          .select(['id', 'name', 'username'])
          .where('id', 'in', ids)
          .execute();
        const byId = new Map(rows.map((row) => [String(row.id), row]));
        for (const ref of wanted) {
          const row = byId.get(ref.id);
          const name = row?.name ?? row?.username;
          if (typeof name === 'string' && name.length > 0) {
            // 别的类型（角色、agent）不答：本条只有人员有姓名。
            names.set(`user:${ref.id}`, name);
          }
        }
        return names;
      },
    };
  }
}
