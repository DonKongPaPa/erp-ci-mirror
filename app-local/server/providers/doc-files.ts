import type { Application } from '@nocobase/app-server/application';
import { databaseManagerToken, type DatabaseManager } from '@nocobase/db';
import { driveManagerToken } from '@nocobase/app-server/drive';
import {
  createServiceToken,
  ServiceProvider,
  type ServiceToken,
} from '@nocobase/service-provider';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Knex } from 'knex';

/**
 * R-021 加片「单据附件」：一张通用附件表 + 本机盘的存取。
 *
 * 存储照 R-026 第四片：应用自己调盘的 putStream / getStream，不登记插件的公开内容路由。
 * 上传的人与存储位置只留在库里，任何读响应都只回四个公开列。
 */
export const DOC_FILE_MAX_BYTES = 10 * 1024 * 1024;
export const DOC_FILE_BODY_SLACK = 64 * 1024;
export const DOC_FILE_TYPES: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
};
export const DOC_FILE_MAX_COUNT = 10;

export type DocFileRuleCode = 'file-not-found' | 'file-unavailable' | 'file-too-many';

export class DocFileRuleError extends Error {
  public constructor(
    readonly code: DocFileRuleCode,
    readonly detail?: string,
  ) {
    super(detail === undefined ? `Doc file rule violated: ${code}` : `Doc file rule violated: ${code} (${detail})`);
    this.name = 'DocFileRuleError';
  }
}

function fail(code: DocFileRuleCode, detail?: string): never {
  throw new DocFileRuleError(code, detail);
}

export interface DocFileRecord {
  readonly id: string;
  readonly ownerType: string;
  readonly ownerId: string | null;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
  readonly storageKey: string;
  readonly createdById: string;
  readonly createdAt: string | Date;
}

export interface DocFileView {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

interface DocFileRow {
  id: string;
  owner_type: string;
  owner_id: string | null;
  name: string;
  content_type: string;
  size: string | number;
  storage_key: string;
  created_by_id: string;
  created_at: string | Date;
}

const view = (row: DocFileRow): DocFileView => ({
  id: row.id,
  name: row.name,
  contentType: row.content_type,
  size: Number(row.size),
});

const record = (row: DocFileRow): DocFileRecord => ({
  id: row.id,
  ownerType: row.owner_type,
  ownerId: row.owner_id,
  name: row.name,
  contentType: row.content_type,
  size: Number(row.size),
  storageKey: row.storage_key,
  createdById: row.created_by_id,
  createdAt: row.created_at,
});

export function validMime(value: string): string {
  return /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/u.test(value)
    ? value.toLowerCase()
    : 'application/octet-stream';
}

export interface DocFiles {
  upload(file: File, uploaderId: string): Promise<DocFileView>;
  find(knex: Knex, id: string): Promise<DocFileRecord | undefined>;
  filesOf(knex: Knex, ownerType: string, ownerId: string): Promise<readonly DocFileView[]>;
  /** 与单据保存同一事务：整组替换；没有 fileIds 时不碰绑定。 */
  bind(
    knex: Knex,
    ownerType: string,
    ownerId: string,
    fileIds: readonly string[] | undefined,
    uploaderId: string,
  ): Promise<void>;
  content(row: DocFileRecord): Promise<Readable>;
}

export class DatabaseDocFiles implements DocFiles {
  public constructor(
    private readonly database: DatabaseManager,
    private readonly drive: DriveLike,
  ) {}

  public async upload(file: File, uploaderId: string): Promise<DocFileView> {
    if (file.size > DOC_FILE_MAX_BYTES) return fail('file-too-many', 'file-too-large');
    const filename = (Buffer.from(file.name).toString('utf8').split(/[\\/]/u).pop() ?? '')
      .normalize('NFC')
      // eslint-disable-next-line no-control-regex -- Strip controls from an untrusted filename.
      .replace(/[\u0000-\u001f\u007f]/gu, '')
      .trim() || 'file';
    const dot = filename.lastIndexOf('.');
    const ext = dot > 0 ? filename.slice(dot + 1).toLowerCase() : '';
    const declared = String(file.type).toLowerCase();
    if (DOC_FILE_TYPES[declared]?.includes(ext) !== true) {
      return fail('file-unavailable', 'file-type-not-allowed');
    }
    const id = randomUUID();
    const storageKey = `doc-files/${id}.${ext}`;
    const disk = this.drive.use('local');
    await disk.putStream(storageKey, Readable.fromWeb(file.stream()), {
      contentType: declared,
      contentLength: file.size,
    });
    const knex = await this.knex();
    await knex('doc_files').insert({
      id,
      owner_type: '',
      owner_id: null,
      name: filename,
      content_type: declared,
      size: file.size,
      storage_key: storageKey,
      created_by_id: uploaderId,
      created_at: new Date(),
    });
    return { id, name: filename, contentType: declared, size: file.size };
  }

  public async find(knex: Knex, id: string): Promise<DocFileRecord | undefined> {
    const row = await knex<DocFileRow>('doc_files').where({ id }).first();
    return row === undefined ? undefined : record(row);
  }

  public async filesOf(
    knex: Knex,
    ownerType: string,
    ownerId: string,
  ): Promise<readonly DocFileView[]> {
    const rows = await knex<DocFileRow>('doc_files')
      .where({ owner_type: ownerType, owner_id: ownerId })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc');
    return rows.map(view);
  }

  public async bind(
    knex: Knex,
    ownerType: string,
    ownerId: string,
    fileIds: readonly string[] | undefined,
    uploaderId: string,
  ): Promise<void> {
    if (fileIds === undefined) return;
    if (fileIds.length > DOC_FILE_MAX_COUNT) return fail('file-too-many');
    // 先校验再解绑：已经挂在本单据上的文件谁上传的都可以保留，别人的文件仍不能绑。
    // 先解绑会把本单据上的文件变成「无主的别人的文件」，害得继任者保存不了。
    const seen = new Set<string>();
    for (const fileId of fileIds) {
      if (seen.has(fileId)) return fail('file-unavailable', fileId);
      seen.add(fileId);
      const row = await knex<DocFileRow>('doc_files').where({ id: fileId }).first();
      if (row === undefined) return fail('file-not-found', fileId);
      if (row.owner_type === ownerType && row.owner_id === ownerId) continue;
      if (row.created_by_id !== uploaderId || row.owner_id !== null) {
        return fail('file-unavailable', fileId);
      }
    }
    await knex('doc_files')
      .where({ owner_type: ownerType, owner_id: ownerId })
      .update({ owner_id: null });
    if (fileIds.length > 0) {
      await knex('doc_files')
        .whereIn('id', [...fileIds])
        .update({ owner_type: ownerType, owner_id: ownerId });
    }
  }

  public async content(row: DocFileRecord): Promise<Readable> {
    const disk = this.drive.use('local');
    if (!(await disk.exists(row.storageKey))) return fail('file-not-found', row.id);
    return await disk.getStream(row.storageKey);
  }

  private async knex(): Promise<Knex> {
    return await this.database.connection().client<Knex>();
  }
}

/** 只描述本片用到的盘能力，避免把 any 带进业务代码。 */
interface DriveLike {
  use(name: string): {
    putStream(
      key: string,
      stream: Readable,
      options: { contentType: string; contentLength: number },
    ): Promise<unknown>;
    exists(key: string): Promise<boolean>;
    getStream(key: string): Promise<Readable>;
  };
}

type DriveManagerLike = DriveLike;

export const docFilesToken: ServiceToken<DocFiles> =
  createServiceToken<DocFiles>('app/doc-files');

export default class DocFilesProvider extends ServiceProvider<Application> {
  public readonly name: string = 'app.doc-files';

  public override register(): void {
    this.app.container.singleton(docFilesToken, () => {
      const database = this.app.container.resolve(databaseManagerToken);
      const drive = this.app.container.resolve(driveManagerToken) as unknown as DriveManagerLike;
      return new DatabaseDocFiles(database, drive);
    });
  }
}
