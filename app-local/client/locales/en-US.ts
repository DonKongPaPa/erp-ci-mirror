import fileUi from '../extensions/nocobase-file-component-ui/locales/en-US.js';
import type { LocaleResource } from '@nocobase/i18n';

import systemEnUS from './system/en-US.js';

const enUS = {
  // The template's own copy: the shell, the sign-in pages, shared components and the homepage. Keep it in
  // `./system/` so a template upgrade can replace it without touching the application's copy below.
  ...systemEnUS,
  ...fileUi,
  // A failed permission read is not a denial; the route guard says so and offers Retry.
  'status.accessFailed': 'Permission check failed',
  'status.accessFailedDescription':
    'The application could not read your permissions. Refresh and try again.',
  // The application's copy goes here, one group per feature. A shared group such as `navigation` is extended by
  // spreading the system one first, `navigation: { ...systemEnUS.navigation, orders: 'Orders' }`, since a group
  // written here replaces the system group of the same name rather than merging with it.
  navigation: {
    ...systemEnUS.navigation,
    quality: 'Quality tickets',
    ai: 'AI',
    aiModels: 'Models',
    aiAgents: 'Agents',
    aiRuntimes: 'Runtimes',
    aiSkills: 'Skills',
    aiUsage: 'Usage',
  },
  settings: {
    ...systemEnUS.settings,
    // The three child routes that inherit their parent's page grant still need permission titles.
    aiRuntimesConnect: 'Add a runtime',
    aiSkillsNew: 'New skill',
    aiSkillsDetail: 'Skill details',
    // R-012: the department maintenance page's module title and one-line description.
    departments: 'Departments',
    departmentsDescription:
      'Maintain the department tree, its members, the manager and the reporting line.',
    // R-032 / R-034: the two API key pages and the notification log page.
    applicationApiKeys: 'Application API keys',
    applicationApiKeysDescription:
      'Issue keys for service accounts used by external systems; a key acts as its service account, not as the person who issued it.',
    notificationLogs: 'Notification logs',
  },
  // The quality page's own copy, one group for the whole feature.
  quality: {
    page: {
      description:
        'Customer feedback is screened automatically and routed to the responsible department by defect type.',
      eyebrow: 'FQC',
      refresh: 'Refresh',
      loadFailed: 'Load failed',
    },
    permissionFailed: 'Could not read permissions. Refresh and try again.',
    stats: {
      total: 'Tickets',
      open: 'Open',
      critical: 'Critical',
      review: 'Needs review',
    },
    intake: {
      title: 'Simulated customer message',
      description:
        'The server screens the message and creates a ticket immediately. Real channels arrive through the WeCom gateway.',
      defaultSender: 'Zhang',
      senderPlaceholder: 'Customer name',
      contentPlaceholder:
        'For example: this batch is out of tolerance, it will not assemble, 0.3 mm off, the line is stopped',
      submit: 'Submit and screen',
      created: 'Feedback recorded',
      failed: 'Submission failed',
      outcomeUnknown:
        'The last submission’s result is unknown. Check the list for the ticket it may have created before submitting again.',
      acknowledge: 'I have checked',
    },
    department: {
      title: 'By department',
    },
    tickets: {
      title: 'Tickets',
      count: '{{count}} in total, newest first.',
      empty: 'No tickets yet. New tickets appear here as they are created.',
      department: 'Department: {{department}}',
      state: 'State: {{state}}',
    },
    channels: {
      wechat: 'WeChat',
    },
    messages: {
      title: 'Message trail',
      description: "The customer's original message; the AI never rewrites it.",
      unknownSender: 'Unknown',
      empty: 'No messages',
    },
    screenings: {
      title: 'Screening details',
      description: 'Category, severity, suggested owner and confidence.',
      confidence: 'Confidence {{value}}',
      ownerAndModel: 'Suggested owner: {{owner}} · Model: {{model}}',
      empty: 'No screenings',
      review: 'Confirm',
      // R-002: where each draft came from — which engine, and why the model did not run.
      engines: {
        rules: 'Rules',
        model: 'Model',
      },
      degraded: 'Fell back: {{reason}}',
      degrade: {
        'model-disabled': 'Model not enabled',
        'model-not-configured': 'No chat model configured',
        'model-error': 'Model call failed',
        timeout: 'Model timed out',
        'invalid-output': 'Unusable model output',
      },
      knowledge: 'Quality standards: {{refs}}',
      similarCases: 'Similar cases referenced: {{count}}',
    },
    review: {
      saved: 'Screening confirmed',
      failed: 'Review failed',
      record:
        'Confirmed by {{actor}} · {{time}} · {{category}} / {{severity}}',
    },
    // R-002: the drafting outcomes card, fed by GET /quality/drafting/stats.
    drafting: {
      title: 'Drafting outcomes',
      description: 'Drafts against human confirmations over the last year.',
      total: 'Screenings',
      rules: 'Rule drafts',
      model: 'Model drafts',
      confirmed: 'Confirmed',
      categoryMatched: 'Category agreed',
      categoryMismatched: 'Category differed',
      severityMatched: 'Severity agreed',
      severityMismatched: 'Severity differed',
      redacted: 'Redacted before model',
      stale: 'Refresh failed — showing the numbers from the last successful read.',
      retry: 'Retry',
    },
    empty: 'No data',
    loading: 'Loading',
    unassigned: 'Unassigned',
    uncategorized: 'Uncategorized',
    categories: {
      appearance: 'Appearance',
      dimension: 'Dimension',
      function: 'Function',
      packaging: 'Packaging',
      material: 'Material',
      process: 'Process',
      other: 'Other',
    },
    severities: {
      critical: 'Critical',
      major: 'Major',
      minor: 'Minor',
      info: 'Info',
    },
    states: {
      open: 'Open',
      in_progress: 'In progress',
      resolved: 'Resolved',
      closed: 'Closed',
    },
    outcomes: {
      auto: 'Auto routed',
      'needs-review': 'Needs review',
      reviewed: 'Reviewed',
    },
  },
  // R-012: the department maintenance page. Rejections say what to do next, not just what failed.
  departments: {
    tree: 'Department tree',
    details: 'Department details',
    members: 'Members',
    loading: 'Loading departments',
    retry: 'Retry',
    empty: 'No departments yet. Create the first one.',
    selectPrompt: 'Select a department to see its details and members.',
    toggle: 'Expand or collapse {{title}}',
    inactive: 'Inactive',
    new: 'New department',
    name: 'Name',
    code: 'Code',
    type: 'Type',
    parent: 'Parent department',
    noParent: 'No parent (root)',
    sortOrder: 'Sort order',
    manager: 'Manager',
    noManager: 'No manager',
    clearManager: 'Clear',
    save: 'Save',
    saving: 'Saving…',
    saved: 'Department saved',
    cancel: 'Cancel',
    activate: 'Activate',
    activatedToast: 'Department activated',
    deactivate: 'Deactivate',
    deactivateTitle: 'Deactivate department',
    deactivateDescription:
      'A department can be deactivated only when it has no members and no active child departments. A successor lets later reports follow where the work moved.',
    successor: 'Successor (optional)',
    noSuccessor: 'No successor',
    deactivating: 'Deactivating…',
    deactivatedToast: 'Department deactivated',
    merge: 'Merge into…',
    mergeTitle: 'Merge department',
    mergeDescription:
      'Members, primary markers and the manager move to the target; the source department is deactivated and records its successor. This cannot be undone.',
    mergeTarget: 'Target department',
    merging: 'Merging…',
    mergedToast: 'Department merged',
    createTitle: 'Create a department',
    createDescription:
      'Name and code are required. Other modules refer to the department by its code.',
    create: 'Create',
    creating: 'Creating…',
    created: 'Department "{{title}}" created',
    addMembers: 'Add members',
    addMembersTitle: 'Add members',
    addMembersDescription:
      'Search by name or username. People who are already members are not listed.',
    search: 'Search',
    searchPlaceholder: 'Name or username',
    searchResults: 'Search results',
    searchHint: 'Type at least one character to search.',
    searchEmpty: 'No one matches.',
    selectedCount: '{{count}} selected',
    addSelected: 'Add selected',
    adding: 'Adding…',
    addedToast: 'Added {{count}} member(s)',
    memberName: 'Name',
    username: 'Username',
    primaryColumn: 'Primary department',
    isPrimary: 'Primary',
    managerColumn: 'Manager',
    isManager: 'Manager',
    actions: 'Actions',
    actionsFor: 'Actions for {{name}}',
    selectAll: 'Select all on this page',
    selectPerson: 'Select {{name}}',
    makePrimary: 'Make primary department',
    primarySaved: 'Primary department set for {{name}}',
    makeManager: 'Make manager',
    managerSaved: '{{name}} is now the manager',
    removeMember: 'Remove from department',
    removedToast: '{{name}} removed from the department',
    transferTarget: 'Move to',
    chooseTarget: 'Choose a target department',
    transfer: 'Move selected',
    transferring: 'Moving…',
    transferredToast: 'Moved {{moved}} member(s)',
    noMembers: 'No members yet.',
    noViewTitle: 'You cannot open department management',
    noViewDescription:
      'Your role does not have the "View departments" permission. Ask an administrator to grant it under Roles and permissions.',
    kind: {
      company: 'Company',
      center: 'Center',
      department: 'Department',
      team: 'Team',
    },
    errors: {
      denied:
        'You do not have permission for this action. Ask an administrator to grant your role "Manage departments".',
      duplicateTitle:
        'Another department under the same parent already uses this name. Choose a different name.',
      duplicateCode:
        'Another department already uses this code. Choose a different code.',
      cycle:
        'A department cannot be its own parent or be moved under one of its descendants. Choose another parent.',
      managerNotMember:
        'This person is not a member of this department yet. Add them as a member first.',
      managerCannotBeRemoved:
        'This person is the department manager. Choose another manager first, then remove them.',
      primaryDepartmentInUse:
        'This is the person’s primary department and they still belong to other departments. Make one of those their primary department first.',
      primaryConflict:
        'Another session changed this person’s primary department at the same time. Reload and try again.',
      hasMembers:
        'This department still has members. Move them out or transfer them first.',
      hasActiveChildren:
        'This department still has active child departments. Deactivate or move them first.',
      deactivated: 'This department is deactivated. Activate it first.',
      parentDeactivated:
        'The parent department is deactivated. Choose another parent or activate it first.',
      successorDeactivated:
        'The successor is deactivated. Choose an active department.',
      mergeSourceDeactivated:
        'This department is already deactivated; there is nothing to merge.',
      mergeSourceHasChildren:
        'This department still has active child departments. Merge or move them first.',
      mergeTargetSelf:
        'A department cannot be merged into itself. Choose another target department.',
      mergeTargetDeactivated:
        'The target department is deactivated. Choose an active department.',
      mergeTargetRequired: 'Choose a target department.',
      transferNotMember:
        'Someone in the selection is no longer a member of this department. Reload and try again.',
      transferIncludesManager:
        'The selection includes the department manager. Choose another manager first.',
      transferInvalid:
        'A move needs a source department and a different target department.',
      missingDepartment: 'The department no longer exists. Reload the page.',
      missingMembership:
        'This person is no longer a member of the department. Reload the page.',
      titleRequired: 'A department needs a name.',
      codeRequired: 'A department needs a code.',
      invalidKind:
        'The department type is not one of the four kinds. Choose one of them.',
      invalidRequest: 'Some input is not valid. Check it and try again.',
      session: 'Your session has ended. Sign in again.',
      conflict:
        'The change conflicts with the current data. Reload and try again.',
      failed: 'The request failed. Try again.',
    },
  },
  // R-013: the FQC resource, its actions and the two department record access keys.
  authorization: {
    sections: {
      quality: 'Quality management',
      organization: 'Organization',
    },
    fqc: {
      title: 'FQC quality feedback',
      messages: 'Customer messages',
      screenings: 'AI screening',
      tickets: 'Quality tickets',
      routingRules: 'Routing rules',
      actions: {
        view: 'View',
        handle: 'Review and dispatch',
        intake: 'Intake',
        ticket: 'Handle ticket',
        configure: 'Maintain routing rules',
        submit: 'Submit feedback',
        maintain: 'Maintain feedback',
      },
    },
    // R-012: the department business resource and the three tables its two actions expand to.
    departments: {
      title: 'Departments',
      tables: {
        departments: 'Departments',
        members: 'Department members',
        history: 'Member changes',
      },
      actions: {
        view: 'View departments',
        manage: 'Manage departments',
      },
    },
    // R-011: the employee business resource and the four tables its two actions expand to.
    employees: {
      title: 'Employees',
      tables: {
        employees: 'Employee profiles',
        changes: 'Employee changes',
        positions: 'Positions',
        jobGrades: 'Job grades',
      },
      actions: {
        view: 'View employees',
        manage: 'Manage employees',
      },
    },
    recordAccess: {
      myDepartments: 'My departments',
      myDepartmentsAndBelow: 'My departments and below',
    },
  },
  // R-013: the names of the four business permission sets the seed creates.
  permissionSets: {
    business: {
      qualityManager: 'Quality manager',
      qualityInspector: 'Quality inspector',
      deptManager: 'Department manager',
      staff: 'Staff',
    },
  },
  // R-037: the development-only account switch in the avatar menu.
  devTools: {
    accountSwitcher: {
      title: 'Switch account',
      developmentOnly: 'Development only',
      current: 'Current account',
      failed: 'Could not switch to {{name}}.',
    },
  },
  // R-032 / R-034: the account menu, the two API key pages and the notification log page.
  account: {
    ...systemEnUS.account,
    apiKeys: 'API keys',
  },
  apiKeys: {
    common: {
      name: 'Name',
      namePlaceholder: 'For example: WeCom adapter',
      purpose: 'Purpose',
      purposePlaceholder: 'Who uses this key and for what',
      validity: 'Valid for',
      daysRequired: 'The expiry is required, from 1 to 365 days.',
      daysOptional: 'Leave empty for no expiry; otherwise 1 to 365 days.',
      invalidDays: 'Enter a whole number of days from 1 to 365.',
      cancel: 'Cancel',
      create: 'Create',
      save: 'Save',
      saving: 'Working…',
      failed: 'The operation failed. Try again.',
      copied: 'Copied to the clipboard',
      copyFailed: 'Unable to copy. Select the text and copy it manually.',
      copy: 'Copy',
      done: 'Saved it, close',
      secret: 'Key secret',
      secretHint:
        'This is the only time the secret is shown. It cannot be viewed again after closing; rotate the key if it is lost.',
      rotate: 'Rotate',
      revoke: 'Revoke',
      rotateTitle: 'Rotate {{name}}?',
      rotateHint:
        'The old secret stops working at once. Whatever uses it must switch to the new secret.',
      revokeTitle: 'Revoke {{name}}?',
      revokeHint:
        'Whatever uses this key stops working at once. This cannot be undone.',
      actionsFor: 'Actions for {{name}}',
      actions: 'Actions',
      status: 'Status',
      statusLabel: {
        active: 'Active',
        expired: 'Expired',
        disabled: 'Disabled',
      },
      lastUsedAt: 'Last used',
      createdAt: 'Created',
      neverUsed: 'Never used',
      neverExpires: 'Never expires',
      unnamed: 'Unnamed',
      rotatedTitle: 'Key rotated',
      revoked: 'Key revoked',
      replayed:
        'This request was already handled; the secret appeared only in the first response. Rotate the key to get a new one.',
      outcomeUnknown:
        'The last submission’s result is unknown (the connection dropped or timed out). Retrying the same details confirms whether it took effect; before changing anything, check whether it is already in the list.',
      retryOriginal: 'Retry the original',
      acknowledgeNotCommitted: 'I have checked; it is not in the list',
    },
    personal: {
      title: 'My API keys',
      description: 'A key calls the API as you: it has your permissions.',
      create: 'Create a key',
      createForbidden:
        'Only root may create or rotate API keys right now. You can still view and revoke the keys you already have.',
      createTitle: 'Create an API key',
      createDescription:
        'The name and purpose help you recognize the key later.',
      createdTitle: 'Key created',
      createFailed: 'Creation failed. Check the name and the expiry.',
      empty: 'No keys yet.',
    },
    application: {
      title: 'Application API keys',
      description:
        "External systems enter the application with these keys. A key acts as its service account, and what it can do comes from that account's roles; this page issues keys and grants no permissions.",
      newAccount: 'New service account',
      newAccountTitle: 'New service account',
      newAccountDescription:
        'A service account has no password and never signs in; it acts only through keys issued to it. Issue its first key here afterwards.',
      accountName: 'Name',
      accountNamePlaceholder: 'For example: WeCom gateway',
      newAccountFailed: 'Creation failed. Check the name.',
      account: 'Service account',
      accountHint:
        'Keys authenticate as the service account; what it can do comes from the roles it holds.',
      accountDisabled: '{{name}} (disabled)',
      noAccounts:
        'No service accounts yet. Create one first, then issue it a key.',
      keysTitle: 'Keys of {{name}}',
      issue: 'Issue a key',
      issueTitle: 'Issue an application key',
      issueDescription:
        'An application key must expire: 1 to 365 days, 90 by default. The secret is shown once.',
      issuedTitle: 'Key issued',
      issueFailed: 'Issuing failed. Check the name and the expiry in days.',
      empty: 'This service account has no keys yet.',
      roles: 'Roles',
      noRoles: 'No roles yet; its keys can sign in but may do nothing.',
      adjustRoles: 'Adjust roles',
      rolesTitle: 'Roles of {{name}}',
      rolesDescription:
        'A key acts as this service account; what it may do comes from these Permission Sets. Saving replaces them all; choosing none gives it nothing. The set that confers root is never offered here.',
      rolesSaveFailed: 'Saving the roles failed. Try again.',
      rolesSaved: 'Roles saved',
    },
  },
  notificationLogs: {
    title: 'Notification logs',
    description:
      'Whether each notification went out and which step failed. Read-only; by design recipients and message content are not in the record.',
    sentAt: 'Time',
    source: 'Source',
    status: 'Status',
    deliveries: 'Deliveries',
    deliveryCount: '{{name}} × {{count}}',
    actions: 'Actions',
    actionsFor: 'Notification actions for {{source}}',
    open: 'View details',
    noDeliveries: 'No deliveries',
    empty: 'No notification logs yet.',
    loadMore: 'Load more',
    loading: 'Loading…',
    detailTitle: 'Notification details',
    detailDescription:
      "Each delivery's channel, status, attempt count and failure reason.",
    updatedAt: 'Updated',
    attempts: '{{count}} attempts',
    nextRunAt: 'Next retry {{time}}',
    lastError: 'Failure: {{category}} · {{message}}',
    attemptLine: 'Attempt {{sequence}}: {{status}} · {{time}}',
    attemptError: '{{category}} · {{message}}',
    readOnlyHint: 'This page is read-only; it cannot resend or delete.',
    statusLabel: {
      pending: 'Pending',
      processing: 'Processing',
      completed: 'Completed',
      partial: 'Partly failed',
      failed: 'Failed',
      unknown: 'Unknown',
    },
    deliveryStatus: {
      pending: 'Pending',
      preparing: 'Preparing',
      submitting: 'Submitting',
      retrying: 'Retrying',
      accepted: 'Accepted',
      failed: 'Failed',
      unknown: 'Unknown',
    },
  },
};

/**
 * The shape every locale of this application follows, derived from the English wording above.
 *
 * Anything a plugin does not translate falls back to this namespace, so a term defined here is reused everywhere
 * without each plugin repeating it.
 */
export type AppResource = LocaleResource<typeof enUS>;

export default enUS;
