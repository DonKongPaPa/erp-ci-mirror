/**
 * R-082 开发工具（需求池看板）的词条。只由两份主语言包在开发构建里并入（R-073）：
 * 生产构建的语言包里没有这一组。
 */
export default {
  requirementsBoard: {
    title: '需求池看板',
    menuEntry: '需求池看板',
    loading: '正在加载需求池看板…',
    loadFailed: '需求池看板加载失败。',
    total: '共 {{count}} 条',
    skipped: '解析跳过 {{count}} 条',
    generatedAt: '生成时刻 {{at}}',
    byStatus: '各状态',
    suggestedOrder: '建议次序',
    inProgress: '在途',
    ready: '可开工',
    blocked: '等依赖',
    reasonInProgress: '在途，最新跟进 {{at}}',
    reasonReady: '依赖已完成，可以开工',
    reasonBlocked: '等 {{deps}}',
    filters: '筛选',
    board: '看板',
    category: '分类',
    allCategories: '全部',
    business: '业务',
    engineering: '工程',
    onlyUnfinished: '只看未完成',
    search: '按编号或名称搜索',
    note: '需求池备注',
    dependencies: '依赖',
    latestEntry: '最新跟进',
    noEntries: '暂无跟进',
    openDetail: '打开 {{name}} 的详情',
  },
};
