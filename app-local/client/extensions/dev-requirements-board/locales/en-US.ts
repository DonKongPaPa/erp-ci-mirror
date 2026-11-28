/**
 * R-082 开发工具（需求池看板）的词条。只由两份主语言包在开发构建里并入（R-073）：
 * 生产构建的语言包里没有这一组。
 */
export default {
  requirementsBoard: {
    title: 'Requirements board',
    menuEntry: 'Requirements board',
    loading: 'Loading the requirements board…',
    loadFailed: 'The requirements board could not be loaded.',
    total: '{{count}} requirements',
    skipped: '{{count}} skipped',
    generatedAt: 'Generated at {{at}}',
    byStatus: 'By status',
    suggestedOrder: 'Suggested order',
    inProgress: 'In progress',
    ready: 'Ready to start',
    blocked: 'Waiting on dependencies',
    reasonInProgress: 'In progress, latest follow-up {{at}}',
    reasonReady: 'Dependencies done, ready to start',
    reasonBlocked: 'Waiting for {{deps}}',
    filters: 'Filters',
    board: 'Board',
    category: 'Category',
    allCategories: 'All',
    business: 'Business',
    engineering: 'Engineering',
    onlyUnfinished: 'Only unfinished',
    search: 'Search by id or name',
    note: 'Pool note',
    dependencies: 'Dependencies',
    latestEntry: 'Latest follow-up',
    noEntries: 'No follow-up yet',
    openDetail: 'Open details for {{name}}',
  },
};
