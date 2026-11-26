import type { AppServerResource } from './en-US.js';

const zhCN: AppServerResource = {
  employees: {
    errors: {
      'target-user-not-found': '这个账号不存在。',
      'service-account': '服务账号不能建员工档案。',
      'profile-exists': '这个账号已经有员工档案。',
      'profile-not-found': '这个账号没有员工档案。',
      'already-left': '这个人已经离职。',
      'not-left': '只有已离职的人才能复聘。',
      'invalid-reference': '岗位、职级或部门不存在。',
      'invalid-date': '日期要写成 YYYY-MM-DD。',
      'invalid-update': '岗位、职级、直属上级至少要带一项。',
      'reports-to-self': '不能自己向自己汇报。',
      'reports-to-cycle': '这样设置汇报关系会成环。',
      'reports-to-not-active': '直属上级必须是有档案的在职员工。',
      'position-inactive': '这个岗位已经停用，请换一个或清空。',
      'grade-inactive': '这个职级已经停用，请换一个或清空。',
      'position-in-use': '还有在职员工在用这个岗位，请先改派。',
      'grade-in-use': '还有在职员工在用这个职级，请先改派。',
      'dictionary-exists': '这个编码已经被占用。',
      'dictionary-not-found': '这条字典记录不存在。',
      'self-leave': '不能给自己办离职。',
      'is-department-manager': '请先更换部门负责人，再办离职。',
      'has-direct-reports': '请先改派在职下属，再办离职。',
      'offboard-rejected': '离职前检查拦住了这次办理：{{reason}}',
      'account-protected': '只有 root 管理员能操作这个账号。',
      'employee-no-conflict': '工号分配出现冲突，请重试。',
      'employee-no-exhausted': '工号已用到 E999999，无法继续发号。',
    },
  },
};

export default zhCN;
