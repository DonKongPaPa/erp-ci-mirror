import { defineMigration, type MigrationDefinition } from '@nocobase/db';

/**
 * R-021 加片「单据附件」：各类单据共用的一张附件表。
 *
 * 九列按设计写死；不建外键，`ownerId` 上传时为空、随单据保存绑上。
 * `storageKey` 与 `createdById` 是内部列，任何响应都不回。
 * 两个索引：按单据取附件、按上传人清理挂单文件。down 删表即删索引。
 */
const migration: MigrationDefinition = defineMigration({
  name: '202611260020_doc_files',
  async up({ builder }) {
    await builder.createCollection('docFiles', (collection) => {
      collection.string('id', { length: 64 }).notNull();
      collection.string('ownerType', { length: 32 }).notNull();
      collection.string('ownerId', { length: 64 }).nullable();
      collection.string('name', { length: 255 }).notNull();
      collection.string('contentType', { length: 128 }).notNull();
      collection.integer('size').notNull();
      collection.string('storageKey', { length: 255 }).notNull();
      collection.string('createdById', { length: 64 }).notNull();
      collection.datetimeTz('createdAt').notNull();
      collection.primary('id', { name: 'pk_doc_files' });
      collection.index(['ownerType', 'ownerId'], { name: 'ix_doc_files_owner' });
      collection.index(['createdById', 'createdAt'], {
        name: 'ix_doc_files_owner_created',
      });
    });
  },
  async down({ builder }) {
    await builder.dropCollection('docFiles');
  },
});

export default migration;
