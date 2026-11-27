import { resolveAppUrl, type ApiClient } from '@nocobase/app-client';

/**
 * R-021 加片「单据附件」的客户端：上传走 `POST /api/doc-files`，取内容走
 * `GET /api/doc-files/:id/content`。单据保存时用 `fileIds` 整组绑定，
 * 所以上传先拿到 id，随单据一起提交；从组里去掉的文件不删除，只是不再属于这张单。
 */
export const DOC_FILE_MAX_COUNT = 10;
export const DOC_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** 与服务端 `DOC_FILE_TYPES` 同一张表：声明类型与扩展名都要对得上。 */
const TYPES: Readonly<Record<string, readonly string[]>> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'application/pdf': ['pdf'],
};

export interface DocFile {
  readonly id: string;
  readonly name: string;
  readonly contentType: string;
  readonly size: number;
}

/** 客户端先筛一遍：不合规的文件不发请求，免得留下没人引用的孤儿文件。 */
export function acceptDocFiles(
  picked: readonly File[],
  used: number,
): readonly File[] {
  const accepted: File[] = [];
  for (const file of picked) {
    if (used + accepted.length >= DOC_FILE_MAX_COUNT) break;
    const type = file.type.toLowerCase();
    const ext = file.name.split('.').pop()?.toLowerCase() ?? '';
    if (file.size > DOC_FILE_MAX_BYTES) continue;
    if (!TYPES[type]?.includes(ext)) continue;
    accepted.push(file);
  }
  return accepted;
}

export function docFileImage(file: DocFile): boolean {
  return file.contentType.startsWith('image/');
}

export class DocFilesClient {
  constructor(private readonly api: ApiClient) {}

  async upload(file: File): Promise<DocFile> {
    const body = new FormData();
    body.append('file', file);
    return this.api.request<DocFile>({
      path: 'doc-files',
      method: 'POST',
      body,
    });
  }

  /** 浏览器直链走同一会话的 cookie；服务端回的是只作下载的内容。 */
  contentUrl(id: string): string {
    return resolveAppUrl(`/api/doc-files/${encodeURIComponent(id)}/content`);
  }
}
