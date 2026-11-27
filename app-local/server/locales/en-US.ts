import type { LocaleResource } from '@nocobase/i18n';

/**
 * Application-owned server wording. Employee endpoints translate their error
 * messages through the request translator; plugins keep their own namespaces.
 */
const enUS = {
  partners: {
    errors: {
      kindRequired: 'A partner must be a customer, a supplier, or both.',
      invalidName: 'The name is required.',
      codeTaken: 'That code is already in use.',
      partnerNotFound: 'That partner does not exist.',
      partnerInactive: 'That partner is inactive; reactivate it first.',
      contactNotFound: 'That contact does not exist on this partner.',
      invalidUpdate: 'Give at least one field to change.',
    },
  },
  items: {
    errors: {
      'invalidInput': 'Some values are not valid: {{reason}}. Check the field and try again.',
      'itemNotFound': 'That item does not exist. Reload and try again.',
      'unitNotFound': 'That unit of measure does not exist. Reload and try again.',
      'categoryNotFound': 'That item category does not exist. Reload and try again.',
      'codeTaken': 'That item code is already in use; retry the request.',
      'unitCodeTaken': 'That unit code is already in use. Choose another.',
      'categoryCodeTaken': 'That category code is already in use. Choose another.',
      'itemCodeImmutable': 'An item code cannot be changed after it is issued.',
      'emptyPatch': 'Give at least one field to change.',
      'unitInUse': 'An item still uses that unit. Reassign the item first.',
      'unitInactive': 'That unit is inactive. Choose another one.',
      'categoryInactive': 'That category is inactive. Choose another one.',
      'itemInactive': 'That item is inactive. Reactivate it before changing other fields.',
      'invalidParent': 'A category cannot be its own parent.',
    },
  },
  employees: {
    errors: {
      'target-user-not-found': 'That account does not exist.',
      'service-account': 'A service account cannot have an employee profile.',
      'profile-exists': 'That account already has an employee profile.',
      'profile-not-found': 'That account has no employee profile.',
      'already-left': 'That person has already left.',
      'not-left': 'Only a person who has left can be rehired.',
      'invalid-reference': 'The position, grade or department does not exist.',
      'invalid-date': 'Dates must be written as YYYY-MM-DD.',
      'invalid-update': 'Give at least one of positionId, gradeId or reportsToUserId.',
      'reports-to-self': 'A person cannot report to themselves.',
      'reports-to-cycle': 'That reporting line would make a cycle.',
      'reports-to-not-active': 'The supervisor must be an active employee with a profile.',
      'position-inactive': 'That position is inactive; choose another one or clear it.',
      'grade-inactive': 'That grade is inactive; choose another one or clear it.',
      'position-in-use': 'An active employee still uses that position. Reassign them first.',
      'grade-in-use': 'An active employee still uses that grade. Reassign them first.',
      'dictionary-exists': 'That code is already in use.',
      'dictionary-not-found': 'That dictionary entry does not exist.',
      'self-leave': 'You cannot process your own departure.',
      'is-department-manager': 'Change the department manager before processing this departure.',
      'has-direct-reports': 'Reassign the direct reports before processing this departure.',
      'offboard-rejected': 'A pre-departure check stopped this departure: {{reason}}',
      'account-protected': 'Only a root administrator can process this account.',
      'employee-no-conflict': 'Employee numbers were contested; retry the request.',
      'employee-no-exhausted': 'All employee numbers up to E999999 are used; no more can be issued.',
    },
  },
 ticketNotifications: {
    contributor: 'Quality tickets',
    category: 'Quality tickets',
    businessRule: 'Sent once after the transition commits; replaying the same idempotency key does not resend.',
    languagePolicy: 'One message in the application default language.',
    channel: 'Inbox',
    variables: {
      code: 'Ticket code',
      state: 'Ticket state',
    },
    dispatch: {
      name: 'Ticket dispatched',
      trigger: 'After a screening is confirmed and dispatched.',
      recipients: 'The responsible department manager and the assignee.',
      title: 'Ticket {{code}} dispatched',
      body: 'Ticket {{code}} is now {{state}}.',
    },
    reassign: {
      name: 'Ticket reassigned',
      trigger: 'After a ticket is reassigned.',
      recipients: 'The responsible department manager, the assignee and the previous assignee.',
      title: 'Ticket {{code}} reassigned',
      body: 'Ticket {{code}} is now {{state}}.',
    },
    resolve: {
      name: 'Ticket resolved',
      trigger: 'After a ticket is resolved.',
      recipients: 'The person who confirmed and dispatched the ticket.',
      title: 'Ticket {{code}} resolved',
      body: 'Ticket {{code}} is now {{state}}.',
    },
    close: {
      name: 'Ticket closed',
      trigger: 'After a ticket is closed.',
      recipients: 'The assignee.',
      title: 'Ticket {{code}} closed',
      body: 'Ticket {{code}} is now {{state}}.',
    },
    reopen: {
      name: 'Ticket reopened',
      trigger: 'After a ticket is reopened.',
      recipients: 'The assignee and the responsible department manager.',
      title: 'Ticket {{code}} reopened',
      body: 'Ticket {{code}} is now {{state}}.',
    },
  },
} as const;

export type AppServerResource = LocaleResource<typeof enUS>;


export default enUS;
