import type { PagePermissionTitles } from './page-permissions.js';

/** Permission labels for application pages without navigation/breadcrumb titles (including overlays).
 * Keys are existing route names; values are application translation keys.
 * Do not add navigation/breadcrumbs or change authorization ids just to name a permission.
 */
export const pagePermissionTitles: PagePermissionTitles = {
  // The template detail drawer shares the list page grant.
  notificationTemplate: 'settings.notificationTemplates',
  // The AI Agent plugin's child routes inherit their parent's page grant and declare no navigation of their own.
  'runtimes-connect': 'settings.aiRuntimesConnect',
  'skills-new': 'settings.aiSkillsNew',
  'skills-detail': 'settings.aiSkillsDetail',
  // R-026：两个覆盖在反馈单列表上的子路由继承父页授权，权限清单里要有可读的名字。
  feedbackNew: 'feedbacks.form.titleNew',
  feedbackDetail: 'feedbacks.form.titleEdit',
  // R-014 / R-025：路由上的对话框与抽屉继承列表页的页面授权，权限清单里要有可读的名字。
  shiftNew: 'shifts.form.newTitle',
  shiftEdit: 'shifts.form.editTitle',
  shiftCopy: 'shifts.form.copyTitle',
  partnerNew: 'partners.newTitle',
  partnerDetail: 'partners.detailTitle',
  partnerEdit: 'partners.form.editTitle',
  partnerContactNew: 'partners.contact.addTitle',
  partnerContactEdit: 'partners.contact.editTitle',
  // R-019：物料页的路由对话框与抽屉继承列表页的页面授权，权限清单里要有可读的名字。
  itemNew: 'items.form.newTitle',
  itemDetail: 'items.detailTitle',
  itemEdit: 'items.form.editTitle',
  unitNew: 'items.units.newTitle',
  unitEdit: 'items.units.editTitle',
  categoryNew: 'items.categories.newTitle',
  categoryEdit: 'items.categories.editTitle',
};
