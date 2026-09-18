'use strict';

/**
 * 自定义标题栏的渲染逻辑。
 * 只做「显示 + 转发动作」，所有权限判断都在主进程。
 *
 * 窗口拖动也在这里：整条标题栏是拖拽区，用 pointer 事件 + setPointerCapture
 * 实现「鼠标移出标题栏也不断」。位置换算在主进程做（屏幕坐标 - 偏移），
 * 这里只负责把屏幕坐标发过去。
 */

const $ = (id) => document.getElementById(id);

let tabs = [];
let activeId = null;
let winState = {};

/* ------------------------------- 渲染标签 ------------------------------- */

function renderTabs() {
  const strip = $('tabstrip');
  strip.textContent = '';
  for (const tab of tabs) {
    const el = document.createElement('div');
    el.className = `tab${tab.active ? ' active' : ''}${tab.failed ? ' failed' : ''}`;
    el.dataset.id = String(tab.id);
    el.title = `${tab.title}\n${tab.url || ''}`;

    if (tab.loading) {
      const sp = document.createElement('span');
      sp.className = 'tab-spinner';
      el.appendChild(sp);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.title || 'DeepSeek';
    el.appendChild(title);

    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '✕';
    close.title = '关闭 (Ctrl+W)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      window.dsChrome.tabAction('close', tab.id);
    });
    el.appendChild(close);

    el.addEventListener('click', () => {
      if (tab.id !== activeId) window.dsChrome.tabAction('activate', tab.id);
    });
    el.addEventListener('auxclick', (e) => {
      if (e.button === 1) {
        e.preventDefault();
        window.dsChrome.tabAction('close', tab.id);
      }
    });

    strip.appendChild(el);
  }

  const active = tabs.find((t) => t.active);
  // 窄窗口下 Tab 条是隐藏的，标题改由这里展示
  $('title-label').textContent = (active && active.title) || 'DeepSeek';
  $('title-label').title = (active && active.url) || '';

  // 保证当前标签可见
  const activeEl = strip.querySelector('.tab.active');
  if (activeEl && activeEl.scrollIntoView) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function renderNavState() {
  const tab = tabs.find((t) => t.active);
  $('btn-back').disabled = !(tab && tab.canGoBack);
  $('btn-forward').disabled = !(tab && tab.canGoForward);
}

function applyWindowState() {
  if (winState.theme) document.documentElement.dataset.theme = winState.theme;
  $('win-max').textContent = winState.maximized ? '❐' : '▢';
  $('win-max').title = winState.maximized ? '还原' : '最大化';
  $('btn-pin').classList.toggle('on', !!winState.alwaysOnTop);

  // 紧凑档显示「展开」图标，反之亦然
  const compact = winState.compact !== false;
  $('btn-size').textContent = compact ? '⤢' : '⤡';
  $('btn-size').title = compact ? '展开为大窗口' : '收起为紧凑小窗口';
  $('btn-size').classList.toggle('on', !compact);
}

/* ------------------------------- 动作绑定 ------------------------------- */

$('win-min').addEventListener('click', () => window.dsChrome.windowAction('minimize'));
$('win-max').addEventListener('click', () => window.dsChrome.windowAction('toggle-maximize'));
$('win-close').addEventListener('click', () => window.dsChrome.windowAction('close'));

$('btn-back').addEventListener('click', () => window.dsChrome.tabAction('back'));
$('btn-forward').addEventListener('click', () => window.dsChrome.tabAction('forward'));
$('btn-reload').addEventListener('click', () => window.dsChrome.tabAction('reload'));
$('btn-newtab').addEventListener('click', () => window.dsChrome.tabAction('new'));

$('btn-palette').addEventListener('click', () => window.dsChrome.openPalette());
$('btn-size').addEventListener('click', () => window.dsChrome.windowAction('toggle-compact'));
$('btn-pin').addEventListener('click', () => window.dsChrome.windowAction('toggle-pin'));
$('btn-diag').addEventListener('click', async () => {
  $('btn-diag').classList.add('on');
  try {
    await window.dsChrome.diagnose();
  } finally {
    setTimeout(() => $('btn-diag').classList.remove('on'), 400);
  }
});

// 双击空白处 = 最大化/还原（和原生标题栏手感一致）
$('titlebar').addEventListener('dblclick', (e) => {
  if (e.target.closest('button') || e.target.closest('.tab')) return;
  window.dsChrome.windowAction('toggle-maximize');
});

// 标签条：滚轮横滚
$('tabstrip').addEventListener(
  'wheel',
  (e) => {
    if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      $('tabstrip').scrollLeft += e.deltaY;
      e.preventDefault();
    }
  },
  { passive: false }
);

/* ------------------------------- 窗口拖动 ------------------------------- */

const bar = $('titlebar');
let dragging = false;
let pending = null;
let rafId = 0;

/** 拖动时每秒能触发上百次 pointermove，用 rAF 合并成最多每帧一次 */
function queueMove(screenX, screenY) {
  pending = { screenX, screenY };
  if (rafId) return;
  rafId = requestAnimationFrame(() => {
    rafId = 0;
    if (pending) {
      window.dsChrome.dragMove(pending.screenX, pending.screenY);
      pending = null;
    }
  });
}

bar.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !e.isPrimary) return;
  // 按钮和标签自己处理点击，不要变成拖窗口
  if (e.target.closest('button') || e.target.closest('.tab')) return;
  dragging = true;
  document.body.classList.add('dragging');
  pending = null;
  try {
    bar.setPointerCapture(e.pointerId);
  } catch (_) {
    /* 个别情况下拿不到 capture 也能用，只是鼠标移出标题栏会断 */
  }
  window.dsChrome.dragStart(e.screenX, e.screenY);
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
  if (pending) {
    window.dsChrome.dragMove(pending.screenX, pending.screenY);
    pending = null;
  }
  if (e && e.pointerId !== undefined) {
    try {
      bar.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
  }
  window.dsChrome.dragEnd();
}

bar.addEventListener('pointerup', endDrag);
bar.addEventListener('pointercancel', endDrag);
window.addEventListener('blur', () => endDrag());

/* ------------------------------- 主进程推送 ------------------------------- */

window.dsChrome.onTabs((payload) => {
  tabs = (payload && payload.tabs) || [];
  activeId = (tabs.find((t) => t.active) || {}).id ?? null;
  renderTabs();
  renderNavState();
});

window.dsChrome.onWindow((state) => {
  winState = state || {};
  applyWindowState();
});

window.dsChrome.getState().then((state) => {
  if (state && state.theme) document.documentElement.dataset.theme = state.theme;
});
