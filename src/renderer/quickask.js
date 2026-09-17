'use strict';

/**
 * 快捷问答面板的渲染逻辑。
 *
 * 只负责三件事：
 *   1. 输入 → 交给主进程
 *   2. 把主进程推来的「多轮对话状态」画出来（问题 / 可折叠的思考过程 / Markdown 正文）
 *   3. 拖窗口
 * 所有权限和站点交互都在主进程 / 站点页 preload。
 */

const $ = (id) => document.getElementById(id);

/** 主题由主进程通过 query 传进来（跟随 nativeTheme） */
const params = new URLSearchParams(location.search);
document.documentElement.dataset.theme = params.get('theme') === 'dark' ? 'dark' : 'light';

const input = $('input');
const contentEl = $('content');
const turnsEl = $('turns');

let state = { phase: 'idle', turns: [], note: '' };

/* ------------------------------ 工具 ------------------------------ */

/**
 * Markdown → HTML：复用 marked（解析）+ DOMPurify（消毒）。
 *
 * 内容是站点生成的**外部内容**（等价于用户输入），消毒这步不能省 ——
 * 否则回复里带一个 `<img onerror=...>` 就能在面板里执行脚本。
 * 两个库任一没加载成功都要能降级（退化成保留换行的纯文本），
 * 绝不能因为渲染器的问题让答案变成一片空白。
 */
function mdToHtml(text) {
  const src = String(text || '');
  try {
    if (window.marked && window.DOMPurify) {
      const raw = window.marked.parse(src, { gfm: true, breaks: true });
      return window.DOMPurify.sanitize(raw, {
        // 图片不渲染：面板 CSP 本来就只允许 self/data，外链图片只会显示成破图
        FORBID_TAGS: ['img', 'style', 'iframe', 'form', 'input'],
        FORBID_ATTR: ['style', 'srcset'],
      });
    }
  } catch (err) {
    console.error('[quickask] Markdown 渲染失败（marked / DOMPurify）', err);
  }
  const div = document.createElement('div');
  div.textContent = src;
  return `<span style="white-space:pre-wrap">${div.innerHTML}</span>`;
}

function nearBottom() {
  return contentEl.scrollHeight - contentEl.scrollTop - contentEl.clientHeight < 90;
}

function scrollToBottom() {
  contentEl.scrollTop = contentEl.scrollHeight;
}

function autoGrow() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(96, input.scrollHeight)}px`;
}

/** 最后一轮的内容长度（正文 + 思考），用来判断「有没有新内容要跟随」 */
function lastLen(s) {
  const turns = (s && s.turns) || [];
  const t = turns.length ? turns[turns.length - 1] : null;
  return t ? String(t.a || '').length + String(t.reasoning || '').length : 0;
}

/* --------------------------- 渲染：多轮对话 --------------------------- */

/** 已渲染的轮次节点（下标与 state.turns 对应）*/
const rendered = [];

function createTurnNode() {
  const root = document.createElement('div');
  root.className = 'turn';

  const q = document.createElement('div');
  q.className = 'q';

  // 思考过程：原生 <details> 折叠；视觉上缩进 + 左边线 + 更小更淡的字
  const think = document.createElement('details');
  think.className = 'think';
  const summary = document.createElement('summary');
  summary.textContent = '思考过程';
  const thinkBody = document.createElement('div');
  thinkBody.className = 'think-body';
  think.appendChild(summary);
  think.appendChild(thinkBody);
  think.hidden = true;

  const a = document.createElement('div');
  a.className = 'a';

  const note = document.createElement('div');
  note.className = 'turn-note hidden';

  root.appendChild(q);
  root.appendChild(think);
  root.appendChild(a);
  root.appendChild(note);

  const node = {
    root,
    q,
    think,
    thinkBody,
    a,
    note,
    userToggledThink: false, // 用户手动开合过，就不再自动改他的选择
    lastA: null,
    lastReasoning: null,
  };

  // 只有「用户点 summary」才算手动操作 —— 程序改 open 也会触发 toggle 事件，
  // 区分不了，所以认 click 而不是认 toggle。
  summary.addEventListener('click', () => {
    node.userToggledThink = true;
  });

  return node;
}

function updateTurnNode(node, turn, isLast) {
  const q = turn.q || '';
  if (node.q.textContent !== q) node.q.textContent = q;

  // ---- 思考过程 ----
  const reasoning = turn.reasoning || '';
  if (node.lastReasoning !== reasoning) {
    node.thinkBody.textContent = reasoning;
    node.lastReasoning = reasoning;
  }
  node.think.hidden = !reasoning;
  if (reasoning && !node.userToggledThink) {
    // 还在思考（正文没出来）→ 自动展开，让人看到进度；正文来了 → 自动收起，让正文当主角
    node.think.open = !(turn.a && turn.a.trim());
  }

  // ---- 正文（Markdown）----
  const text = turn.a || '';
  if (node.lastA !== text) {
    node.a.innerHTML = text ? mdToHtml(text) : '';
    node.lastA = text;
  }
  const busy = isLast && (state.phase === 'generating' || state.phase === 'sending');
  node.a.classList.toggle('streaming', busy);

  // ---- 本轮状态 ----
  node.note.textContent = turn.note || '';
  node.note.classList.toggle('error', isLast && state.phase === 'error');
  node.note.classList.toggle('hidden', !turn.note);
}

/**
 * 增量渲染：只更新变化的节点。
 * 生成中每 400ms 推一次状态，整段重建会卡到没法看。
 */
function renderTurns() {
  const turns = state.turns || [];

  // 轮数变少（点了「新会话」）→ 全部重建
  if (rendered.length > turns.length) {
    rendered.length = 0;
    turnsEl.textContent = '';
  }
  while (rendered.length < turns.length) {
    const node = createTurnNode();
    rendered.push(node);
    turnsEl.appendChild(node.root);
  }
  turns.forEach((t, i) => updateTurnNode(rendered[i], t, i === turns.length - 1));
}

function renderHint() {
  const hasTurn = (state.turns || []).length > 0;
  // 有对话就把空态收起来；完全没进展时（比如会话标签没建起来）才用它报错
  $('hint').classList.toggle('hidden', hasTurn);

  if (state.phase === 'error' && !hasTurn) {
    $('hint-title').textContent = '⚠ 没拿到答案';
    $('hint-body').textContent = state.note || '未知原因';
  } else {
    $('hint-title').textContent = '快捷问答';
    $('hint-body').innerHTML =
      '输入问题按 Enter —— 答案由已登录的 DeepSeek 网页版生成。<br />' +
      '这是一个独立会话，多轮对话有上下文记忆，直到退出应用。';
  }
}

function renderStatus() {
  const busy = state.phase === 'generating' || state.phase === 'sending';
  $('note').textContent = state.note || '';
  $('spinner').classList.toggle('hidden', !busy);

  const turns = state.turns || [];
  const last = turns.length ? turns[turns.length - 1] : null;
  $('copy-hint').classList.toggle('hidden', !(last && (last.a || last.reasoning)));
}

/**
 * 渲染失败不能连坐。
 *
 * 历史教训：`hint-title` 在 HTML 里只有 class 没有 id，`$()` 取到 null，
 * render() 一抛错就把同一次调用里的 focusInput() 一起带走 —— 面板从此
 * 「点不动」，而且没有任何可见提示。所以渲染一律走这里兜一层。
 */
function safeRender() {
  try {
    renderTurns();
    renderHint();
    renderStatus();
  } catch (err) {
    console.error('[quickask] 渲染失败', err);
  }
}

/* ------------------------------ 动作 ------------------------------ */

function submit() {
  const text = input.value.trim();
  if (!text) return;
  if (state.phase === 'sending' || state.phase === 'generating') return; // 一次一个问题
  input.value = '';
  autoGrow();
  window.csQuickAsk.ask(text);
}

input.addEventListener('keydown', (e) => {
  // 中文输入法组字状态下的 Enter 绝不吞
  if (e.isComposing || e.keyCode === 229) return;
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    submit();
  }
});

input.addEventListener('input', autoGrow);

$('btn-open').addEventListener('click', () => window.csQuickAsk.openFull());

$('btn-new').addEventListener('click', () => {
  input.value = '';
  autoGrow();
  window.csQuickAsk.newSession(); // 让站点页开新会话；主进程会把 turns 清空并推回来
  focusInput();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    window.csQuickAsk.close();
    return;
  }
  // 焦点不在输入框时，按 C 复制回答（和 Cherry Studio 一致的肌肉记忆）
  const inInput = document.activeElement === input;
  if (!inInput && (e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey) {
    const turns = state.turns || [];
    const last = turns.length ? turns[turns.length - 1] : null;
    if (last && (last.a || last.reasoning)) {
      e.preventDefault();
      window.csQuickAsk.copy();
    }
  }
});

/* ------------------------------ 拖动 ------------------------------ */

/**
 * 顶部输入条整条可拖，但输入框和按钮不参与 —— 拖拽区绝对不能吃掉输入框的点击，
 * 否则就是「点不进输入框」。所以这里刻意不用 -webkit-app-region: drag（它由浏览器
 * 进程命中测试，脚本没法回归），改成 JS 接管 + pointer capture。
 */
const bar = document.querySelector('.composer');
let dragging = false;
let pending = null;
let rafId = 0;

function queueMove(x, y) {
  pending = { x, y };
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (pending) {
      window.csQuickAsk.dragMove(pending.x, pending.y);
      pending = null;
    }
  });
}

bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary) return;
  if (e.target.closest('textarea, button')) return; // 交互元素不参与拖动
  dragging = true;
  document.body.classList.add('dragging');
  pending = null;
  try {
    bar.setPointerCapture(e.pointerId);
  } catch (_) {
    /* 拿不到 capture 也能用，只是鼠标移出输入条会断 */
  }
  window.csQuickAsk.dragStart(e.screenX, e.screenY);
  e.preventDefault();
});

bar.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  queueMove(e.screenX, e.screenY);
});

function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  document.body.classList.remove('dragging');
  if (rafId) {
    cancelAnimationFrame(rafId);
    rafId = 0;
  }
  // 收尾前先把排队中的最后一次位移发出去，否则快速拖动时最后一段会丢
  if (pending) {
    window.csQuickAsk.dragMove(pending.x, pending.y);
    pending = null;
  }
  if (e && e.pointerId !== undefined) {
    try {
      bar.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  }
  window.csQuickAsk.dragEnd();
}

bar.addEventListener('pointerup', endDrag);
bar.addEventListener('pointercancel', endDrag);

/* --------------------------- 主进程推送 --------------------------- */

window.csQuickAsk.onState((next) => {
  const prev = state;
  state = next || state;

  const prevLen = lastLen(prev);
  const prevCount = (prev.turns || []).length;
  const nextCount = (state.turns || []).length;

  safeRender();

  // 生成中跟随最新内容；新一轮出现时也跟到底。
  // 但用户正在往上翻历史时不要抢他的滚动条。
  const grew = nextCount !== prevCount;
  const gotMore = lastLen(state) !== prevLen;
  if ((grew || (state.phase === 'generating' && gotMore)) && nearBottom()) {
    scrollToBottom();
  }
});

window.csQuickAsk.onReset(() => {
  // 只重置输入框，不清对话 —— 对话由 state 驱动（关掉面板再打开要还在）
  input.value = '';
  autoGrow();
  focusInput();
});

/* ------------------------------ 启动 ------------------------------ */

/**
 * 把焦点落到输入框（「呼出即打字」）。
 *
 * 窗口刚 show 出来时，系统的前台焦点切换和 DOM 的 focus() 会打架，
 * 单次 focus() 经常不生效 —— 所以短时间内重试几次，成功即停。
 */
function focusInput() {
  let tries = 0;
  const tick = () => {
    if (document.activeElement !== input) {
      try {
        input.focus();
      } catch (_) {
        /* ignore */
      }
    }
    if (document.activeElement === input || ++tries >= 6) return;
    setTimeout(tick, 60);
  };
  tick();
}

// ★ 顺序很重要：渲染和聚焦都得走到。
// 以前 render() 一抛错就把 focusInput() 一起带走，面板直接变砖且毫无提示。
safeRender();
focusInput();

// 给自检用的就绪标记。有了它，「渲染脚本崩了」就不会再被误判成「面板点不动」。
window.__qaReady = true;
