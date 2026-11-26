import type {
  AppClientRouteComponentLoader,
  AppClientRouteComponentModule,
} from '@nocobase/app-client/plugins';

import { primeClientRouteModule } from '../../routing/route-module-cache.js';

import FeedbackDetailPage from './detail.js';
import FeedbackNewPage from './new.js';

/**
 * R-026：新建与详情是对话框子路由，框架在页面模块就绪前就把对话框打开了。模块若按路由懒加载，
 * 首帧是宿主的标题加「Loading page」占位（量到 220.8px），模块到齐后换成约 698px 的表单，
 * 居中策略把顶边推上去，形成闪跳。面板级的共享外壳覆盖不到宿主占位那一帧。
 *
 * 这两个页面随入口包静态引入，解析好的模块在应用启动时就备好；loader 每次给出同一份已 resolve
 * 的 Promise，没有打开对话框时的现场 import。直接输入 /feedbacks/new 或 /feedbacks/<id> 也一样，
 * 不依赖先访问链接页去预热。
 */
const newModule: AppClientRouteComponentModule = { default: FeedbackNewPage };
const detailModule: AppClientRouteComponentModule = { default: FeedbackDetailPage };

const newReady: Promise<AppClientRouteComponentModule> = Promise.resolve(newModule);
const detailReady: Promise<AppClientRouteComponentModule> = Promise.resolve(detailModule);

export const loadFeedbackNewModule: AppClientRouteComponentLoader = () => newReady;
export const loadFeedbackDetailModule: AppClientRouteComponentLoader = () => detailReady;

// 同步填缓存：路由表一求值，两个对话框的模块就已经按 loader 身份就绪。
// 首次 render 的 ClientRoute 能直接取到页面，不必等 useEffect 里的 Promise。
primeClientRouteModule(loadFeedbackNewModule, newModule);
primeClientRouteModule(loadFeedbackDetailModule, detailModule);
