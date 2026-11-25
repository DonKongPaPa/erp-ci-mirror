/**
 * 同步查询守门（R-047）：触发动作之后、还没等到稳定态，不许同步查询异步才出现的元素。
 *
 * 判的是「稳态」而不是某个元素：
 *   - 清掉稳态：user.click / user.type / fireEvent 等交互调用，以及 await 的其它动作表达式
 *     （自定义封装、包着交互的 act）。这些之后 UI 可能还在变。
 *   - 立起稳态：await findBy* / findAllBy* / waitFor / waitForElementToBeRemoved，
 *     await 纯数据操作的 act，以及假定时钟的 advance / tick。
 *   - 中性：render / mount 是测试起点，不清也不立 —— 设计规定 render 之后就能查。
 *   - 稳态为假时，同步的 getBy* / getAllBy* 和断言里的 queryBy* / queryAllBy* 报错。
 *
 * 按语句顺序扫，不做数据流分析；不进入嵌套函数体（helper 里的查询算不到调用点头上）。
 * waitFor / act 回调里的查询视为正确 —— 那里本来就该用同步的。
 */

const FUNCTION_TYPES = new Set([
  'FunctionDeclaration',
  'FunctionExpression',
  'ArrowFunctionExpression',
]);

/** `getByRole`、`getAllByText` 这类一查不到就抛的同步查询。 */
const SYNC_GET = /^get(?:All)?By[A-Z]/u;
/** `queryByText`、`queryAllByRole` 这类返回 null 的同步查询，只在断言里算违规。 */
const SYNC_QUERY = /^query(?:All)?By[A-Z]/u;
/** 异步查询：await 到它就说明目标已经出现，稳态立起。 */
const FIND_QUERY = /^find(?:All)?By[A-Z]/u;
const STEADY_WAITS = new Set(['waitFor', 'waitForElementToBeRemoved']);
/** 假定时钟的 advance/tick 等的就是状态落地，和 waitFor 一样是等待，不是动作。 */
const TIMER_WAITS = new Set([
  'advance',
  'advanceTimersByTime',
  'runAllTimers',
  'runOnlyPendingTimers',
  'tick',
]);
const CALLBACK_WRAPPERS = new Set([
  'waitFor',
  'waitForElementToBeRemoved',
  'act',
]);
const USER_INTERACTIONS = new Set([
  'click',
  'dblClick',
  'tripleClick',
  'type',
  'clear',
  'keyboard',
  'tab',
  'selectOptions',
  'upload',
  'paste',
  'pointer',
  'hover',
  'unhover',
  'submit',
]);

/** 兼容 `screen.getByText(...)` 与 `within(x).getByText(...)`：取属性名，不是 callee.name。 */
function calleeName(node) {
  if (!node) return null;
  if (node.type === 'Identifier') return node.name;
  if (
    node.type === 'MemberExpression' &&
    !node.computed &&
    node.property.type === 'Identifier'
  )
    return node.property.name;
  return null;
}

/** `fireEvent.*` 全部算动作；`user.*` / `userEvent.*` 只认交互方法，不认 setup 之类。 */
function isInteraction(node) {
  const callee = node.callee;
  if (callee.type !== 'MemberExpression' || callee.computed) return false;
  if (callee.object.type !== 'Identifier') return false;
  const object = callee.object.name;
  const method = calleeName(callee);
  if (object === 'fireEvent') return true;
  if (object === 'user' || object === 'userEvent')
    return USER_INTERACTIONS.has(method);
  return false;
}

/**
 * render / mount 是测试的起点，不是动作：设计规定「测试一开始算稳态，render 之后就能查」。
 * 这些封装（renderAuthenticatedClient、renderWithApp、mount …）名字不固定，按前缀认。
 */
function isRenderCall(node) {
  if (node.type !== 'CallExpression') return false;
  return /^(?:render|mount)/iu.test(calleeName(node.callee));
}

/** 连函数体一起看：act 里包着点击才算动作，只包数据操作的 act 是等待。 */
function containsInteraction(node) {
  let found = false;
  const visit = (current) => {
    if (!current || typeof current.type !== 'string') return;
    if (current.type === 'CallExpression' && isInteraction(current))
      found = true;
    for (const key of Object.keys(current)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const value = current[key];
      if (Array.isArray(value)) for (const child of value) visit(child);
      else if (value && typeof value.type === 'string') visit(value);
    }
  };
  visit(node);
  return found;
}

/** 被 await 的调用本身是不是「等到稳态」的那种。 */
function isSteadyCall(node) {
  if (node.type !== 'CallExpression') return false;
  const name = calleeName(node.callee);
  if (FIND_QUERY.test(name) || STEADY_WAITS.has(name) || TIMER_WAITS.has(name))
    return true;
  // await act(…)：里面只有数据操作（改语言、resolve 请求、refresh）时，await 已经把
  // 工作做完；只有包着点击/键盘这类交互时才当作触发动作（清稳态）。
  if (name === 'act') return !containsInteraction(node);
  return false;
}

/**
 * 顺序扫描一个函数体，返回按源码位置排好序的事件。
 * `excluded` 表示当前在动作调用或 waitFor/act 回调的子树里 —— 那里的查询不是「后续查询」。
 */
function collectEvents(body) {
  const events = [];

  const walk = (node, excluded, inExpect) => {
    if (!node || typeof node.type !== 'string') return;
    if (FUNCTION_TYPES.has(node.type)) return;

    if (
      node.type === 'AwaitExpression' &&
      !excluded &&
      node.argument.type === 'CallExpression'
    ) {
      if (!isRenderCall(node.argument)) {
        events.push({
          position: node.range[0],
          kind: isSteadyCall(node.argument) ? 'steady' : 'clear',
        });
        // await 了一个动作：它参数里的同步查询是点击的受体，不算违规。
        if (!isSteadyCall(node.argument)) excluded = true;
      }
    }

    if (node.type === 'CallExpression') {
      const name = calleeName(node.callee);
      if (CALLBACK_WRAPPERS.has(name)) {
        // waitFor / act 的回调里用同步查询是对的，整棵子树跳过。
        excluded = true;
      } else if (!excluded && isInteraction(node)) {
        // 没被 await 的 fireEvent.click 也是触发动作，一样清稳态。
        events.push({ position: node.range[0], kind: 'clear' });
        excluded = true;
      } else if (name === 'expect') {
        inExpect = true;
      }

      if (
        !excluded &&
        (SYNC_GET.test(name) || (inExpect && SYNC_QUERY.test(name)))
      )
        events.push({ position: node.range[0], kind: 'query', node });
    }

    for (const key of Object.keys(node)) {
      if (key === 'parent' || key === 'loc' || key === 'range') continue;
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value)
          if (child && typeof child.type === 'string')
            walk(child, excluded, inExpect);
      } else if (value && typeof value.type === 'string') {
        walk(value, excluded, inExpect);
      }
    }
  };

  walk(body, false, false);
  return events.sort((left, right) => left.position - right.position);
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow synchronous queries for async elements after a triggering action',
    },
    schema: [],
    messages: {
      syncQueryAfterAction:
        '这里同步查了一个可能还没出现的元素；先 await findBy… 或 await waitFor(…) 等到稳定态，或者把断言放进 waitFor。确要同步查的，加行内禁用并写明理由。',
    },
  },
  create(context) {
    const check = (node) => {
      const body = node.type === 'Program' ? node : node.body;
      if (body.type !== 'BlockStatement' && body.type !== 'Program') return;
      let steady = true;
      for (const event of collectEvents(body)) {
        if (event.kind === 'clear') steady = false;
        else if (event.kind === 'steady') steady = true;
        else if (event.kind === 'query' && !steady)
          context.report({
            node: event.node,
            messageId: 'syncQueryAfterAction',
          });
      }
    };
    return {
      Program: check,
      FunctionDeclaration: check,
      FunctionExpression: check,
      ArrowFunctionExpression: check,
    };
  },
};
