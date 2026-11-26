import type { LocaleResource } from '@nocobase/i18n';

/**
 * Application-owned server wording. Employee endpoints translate their error
 * messages through the request translator; plugins keep their own namespaces.
 */
const enUS = {
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
} as const;

export type AppServerResource = LocaleResource<typeof enUS>;

export default enUS;
