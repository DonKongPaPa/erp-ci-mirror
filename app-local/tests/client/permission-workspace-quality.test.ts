import type { AuthorizationOptionsResponse } from '@nocobase/app-plugin-authorization/client';
import { expect, it } from 'vitest';

import { permissionWorkspaceCatalog } from '../../client/pages/settings/permission-workspace.js';

/**
 * R-013 角色编辑器要能看到 FQC 的三个动作（验收标准第 7 条的前一半）。
 *
 * 服务端注册了资源还不够：`permissionWorkspaceSelection.business` 里没选中的动作
 * 不会出现在角色编辑器里。这里用默认清单投影一份含 FQC 的目录，断言三个动作都
 * 在，而没选中的动作不出现。
 */
const source = {
  sections: [
    {
      name: 'business',
      title: 'Business operations',
      order: 100,
      subsections: [
        {
          name: 'quality',
          title: 'Quality management',
          resources: [
            {
              type: 'composite',
              id: 'fqc',
              title: 'FQC quality feedback',
              actions: [
                { name: 'view', title: 'View' },
                { name: 'handle', title: 'Handle' },
                { name: 'intake', title: 'Intake' },
                { name: 'retired', title: 'Retired' },
              ],
            },
          ],
        },
      ],
    },
  ],
} as AuthorizationOptionsResponse;

it('R-013: the role editor exposes exactly the selected FQC actions', () => {
  const catalog = permissionWorkspaceCatalog(source, [], []);
  const resources = catalog.sections.flatMap((section) =>
    section.subsections.flatMap((sub) => sub.resources),
  );
  expect(resources.map((resource) => resource.id)).toEqual(['fqc']);
  expect(resources[0]?.actions.map((action) => action.name)).toEqual([
    'view',
    'handle',
    'intake',
  ]);
});
