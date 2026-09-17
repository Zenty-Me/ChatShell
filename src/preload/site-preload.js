'use strict';

/**
 * 站点页 preload —— 注入层（只加不抢，全程容错）。
 *
 * 铁律：
 *   1) 所有 DOM 查询都走 pick()/pickAll()，选不到就 return，绝不 throw；
 *   2) 每个入口整体包 try/catch，注入失败不能让主功能不可用；
 *   3) 不拦网络请求、不伪造响应、不改 navigator.webdriver、不改 UA。
 *
 * 本文件刻意「自包含」：不 require 任何本地文件，保证 sandbox 下也能跑。
 * 选择器与开关由主进程通过 cs:inject-config 下发，集中维护在 src/inject/selectors.json。
 */

const { ipcRenderer } = require('electron');

/* ========================================================================== */
/*                                  状态                                       */
/* ========================================================================== */

const DEFAULT_SETTINGS = {
  enabled: true,
  compact: true,
  hideSidebar: false,
  hideExtras: true,
  ctrlEnterToSend: true,
  copyButtons: true,
};

let SELECTORS = {};
let SETTINGS = { ...DEFAULT_SETTINGS };
let installed = false;
let keyHandlerAttached = false;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function debug(msg) {
  try {
    ipcRenderer.send('cs:log', msg);
  } catch (_) {
    /* ignore */
  }
}

/* ========================================================================== */
/*                            选择器（全部容错）                                */
/* ========================================================================== */

function selectorList(name) {
  const raw = SELECTORS[name];
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.filter((s) => typeof s === 'string');
  if (typeof raw === 'string') return [raw];
  if (Array.isArray(raw.selectors)) return raw.selectors.filter((s) => typeof s === 'string');
  return [];
}

/** 该组配置的文本关键词（按钮没有稳定 class 时的最后一道兜底） */
function keywordsOf(name) {
  const raw = SELECTORS[name];
  if (!raw || Array.isArray(raw) || typeof raw === 'string') return [];
  return Array.isArray(raw.textKeywords) ? raw.textKeywords.filter((k) => typeof k === 'string' && k) : [];
}

const TEXT_MATCH_TAGS = 'button, [role="button"], a[href], [class*="button"], [class*="btn"]';

function labelOf(el) {
  return [el.getAttribute && el.getAttribute('aria-label'), el.title, el.textContent]
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 按文本找元素。两轮：
 *   1) 完全相等（不限长度）—— 「开启新对话」这种长文案也能命中
 *   2) 包含（只接受 ≤4 字的短标签）—— 避免「发送验证码」被当成「发送」按钮
 */
function pickByText(keywords, tags = TEXT_MATCH_TAGS) {
  if (!keywords || !keywords.length) return null;
  let candidates;
  try {
    candidates = Array.from(document.querySelectorAll(tags)).filter((el) => !isOurs(el) && isVisible(el));
  } catch (_) {
    return null;
  }
  const lower = keywords.map((k) => k.toLowerCase());

  for (const el of candidates) {
    const label = labelOf(el).toLowerCase();
    if (label && lower.includes(label)) return el; // 完全相等
  }
  for (const el of candidates) {
    const text = String(el.textContent || '').replace(/\s+/g, ' ').trim();
    const aria = String((el.getAttribute && el.getAttribute('aria-label')) || '').trim();
    const label = (aria || text).toLowerCase();
    if (!label || label.length > 4) continue;
    if (lower.some((k) => label.includes(k))) return el;
  }
  return null;
}

function pick(name) {
  for (const sel of selectorList(name)) {
    try {
      const el = document.querySelector(sel);
      if (el) return el;
    } catch (_) {
      /* 单个选择器写错也不影响其他候选 */
    }
  }
  // 选择器全落空 → 按文本兜底
  try {
    return pickByText(keywordsOf(name));
  } catch (_) {
    return null;
  }
}

function pickAll(name) {
  for (const sel of selectorList(name)) {
    try {
      const list = document.querySelectorAll(sel);
      if (list.length) return Array.from(list);
    } catch (_) {
      /* ignore */
    }
  }
  return [];
}

function isVisible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  try {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  } catch (_) {
    return false;
  }
}

function isOurs(el) {
  return !!(el && el.closest && el.closest('[data-cs-ui]'));
}

/* ------------------------- 带兜底的元素定位（关键） ------------------------- */

/**
 * 输入框。先按 selectors.json 找，找不到就用通用启发式：
 * 页面上最后一个可见的 textarea / contenteditable。
 * 这样即使站点改版把 id 改了，发 Prompt 依然能用。
 */
function resolveInput() {
  const bySelector = pick('composer');
  if (bySelector && !isOurs(bySelector)) return bySelector;

  const cands = Array.from(document.querySelectorAll('textarea, [contenteditable="true"]')).filter(
    (el) => !isOurs(el) && isVisible(el)
  );
  return cands.length ? cands[cands.length - 1] : null;
}

function readableLabel(el) {
  return [el.getAttribute && el.getAttribute('aria-label'), el.title, el.textContent]
    .filter(Boolean)
    .join(' ')
    .slice(0, 60);
}

/** 明显不是「发送」的按钮，别误点（聊天页有停止生成、重新生成、复制等图标按钮） */
const NOT_SEND_LABEL = /停止|重新|重试|复制|编辑|删除|分享|点赞|点踩|stop|regenerate|retry|copy|edit|delete/i;

/**
 * 兜底：找出离输入框最近的那个可见按钮。
 *
 * 实测 DeepSeek 的发送按钮是**纯图标按钮**——没有 aria-label、没有文本，
 * 上面所有基于文案的匹配全都落空。但它在结构上必然紧贴输入框，
 * 所以「几何最近」是这里最稳的判据。
 */
function nearestButtonToComposer(maxDistance = 240) {
  const input = resolveInput();
  if (!input) return null;
  let anchor;
  try {
    const r = input.getBoundingClientRect();
    anchor = { x: r.right, y: r.top + r.height / 2 };
  } catch (_) {
    return null;
  }
  let best = null;
  let bestDist = Infinity;
  let candidates = [];
  try {
    candidates = Array.from(document.querySelectorAll('button, [role="button"], [class*="ds-button"]'));
  } catch (_) {
    return null;
  }
  for (const el of candidates) {
    if (isOurs(el) || !isVisible(el)) continue;
    if (NOT_SEND_LABEL.test(readableLabel(el))) continue;
    let r;
    try {
      r = el.getBoundingClientRect();
    } catch (_) {
      continue;
    }
    const d = Math.hypot(r.left + r.width / 2 - anchor.x, r.top + r.height / 2 - anchor.y);
    if (d < bestDist) {
      bestDist = d;
      best = el;
    }
  }
  return best && bestDist <= maxDistance ? best : null;
}

/**
 * 发送按钮。按可靠程度依次尝试：
 *   1) selectors.json 里的显式候选（含 :is 匹配、文本兜底）
 *   2) aria-label / title 含「发送 / send」的可见按钮，取最后一个（最靠近输入框）
 *   3) 几何上离输入框最近的那个按钮
 */
function resolveSendButton() {
  const direct = pick('sendButton');
  if (direct && !isOurs(direct) && isVisible(direct) && !NOT_SEND_LABEL.test(readableLabel(direct))) {
    return direct;
  }

  const buttons = Array.from(document.querySelectorAll('button, [role="button"], [class*="ds-button"]'));
  const hit = buttons
    .filter((b) => !isOurs(b) && isVisible(b))
    .filter((b) => !NOT_SEND_LABEL.test(readableLabel(b)))
    .filter((b) => /send|发送/i.test(readableLabel(b)))
    .pop();
  if (hit) return hit;

  return nearestButtonToComposer();
}

function isDisabled(el) {
  if (!el) return true;
  try {
    if (el.disabled) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    const cls = String(el.className || '');
    return /disabled|is-disabled/i.test(cls);
  } catch (_) {
    return false;
  }
}

/* ========================================================================== */
/*                           写入输入框 + 发送                                  */
/* ========================================================================== */

function setInputValue(el, text) {
  const tag = el.tagName ? el.tagName.toLowerCase() : '';
  if (tag === 'textarea' || tag === 'input') {
    const proto = tag === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text);
    else el.value = text;
  } else {
    // contenteditable：用 execCommand 兼容性最好，失败再退化到 textContent
    try {
      el.focus();
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (!document.execCommand('insertText', false, text)) throw new Error('execCommand 不可用');
    } catch (_) {
      el.textContent = text;
    }
  }
  try {
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } catch (_) {
    /* ignore */
  }
}

function pressEnter(el) {
  const base = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true, composed: true };
  try {
    el.dispatchEvent(new KeyboardEvent('keydown', base));
    el.dispatchEvent(new KeyboardEvent('keypress', base));
    el.dispatchEvent(new KeyboardEvent('keyup', base));
  } catch (_) {
    /* ignore */
  }
}

/** 发送按钮可能要点完输入框才变可用，所以轮询等待 */
async function clickSend(timeoutMs = 1600) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const btn = resolveSendButton();
    if (btn && !isDisabled(btn)) {
      try {
        btn.click();
        return true;
      } catch (_) {
        /* 继续重试 */
      }
    }
    await sleep(80);
  }
  const input = resolveInput();
  if (input) {
    pressEnter(input);
    return true;
  }
  return false;
}

/** 主进程送来的 Prompt 投递入口 */
async function applyPrompt(text, submit) {
  try {
    // 输入框可能还没渲染出来（面板刚新建会话标签时几乎必然如此）——
    // 直接判失败会让用户看到「找不到输入框」这种莫名其妙的提示，所以要等一等。
    let input = resolveInput();
    for (let i = 0; i < 8 && !input; i++) {
      await sleep(500);
      input = resolveInput();
    }
    if (!input) {
      debug('投递失败：找不到输入框（可能是站点改版，请跑一次选择器自检）');
      toast('找不到输入框，已复制到剪贴板');
      ipcRenderer.send('cs:clipboard', text);
      ipcRenderer.send('cs:prompt-result', { ok: false, reason: '找不到输入框' });
      return false;
    }
    input.focus();
    setInputValue(input, String(text || ''));
    if (!submit) {
      ipcRenderer.send('cs:prompt-result', { ok: true, submitted: false });
      return true;
    }
    await sleep(60);
    const ok = await clickSend();
    if (!ok) {
      toast('没找到发送按钮，内容已填好，请手动回车');
      ipcRenderer.send('cs:prompt-result', { ok: false, reason: '没找到发送按钮，内容已填好' });
    } else {
      ipcRenderer.send('cs:prompt-result', { ok: true, submitted: true });
    }
    return ok;
  } catch (err) {
    debug(`投递异常(已忽略): ${err.message}`);
    ipcRenderer.send('cs:prompt-result', { ok: false, reason: String(err.message || err) });
    return false;
  }
}

/* ========================================================================== */
/*              HTML → Markdown（复用 turndown + 少量站点规则）                 */
/* ========================================================================== */

const TurndownService = require('turndown');
const turndownPluginGfm = require('turndown-plugin-gfm');

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  emDelimiter: '*',
});
turndown.use(turndownPluginGfm.gfm); // 表格 / 删除线 / 任务列表

// 站点特有的「不属于回复内容」的东西：我们注入的 UI、代码块顶栏（语言名 + 复制/下载按钮）。
// 不跳过的话正文里会混进「python 复制 下载」这种噪声（实测踩过）。
turndown.addRule('skip-site-noise', {
  filter: (node) =>
    node.nodeType === 1 &&
    (node.hasAttribute('data-cs-ui') || /md-code-block-banner/.test(node.className || '')),
  replacement: () => '',
});

// 代码块：站点的语言名不在 <code class="language-x"> 里，而是放在顶栏 —— 单独捞一下
turndown.addRule('fenced-code-with-lang', {
  filter: (node) => node.nodeName === 'PRE',
  replacement: (_content, node) => {
    const code = node.querySelector('code') || node;
    let lang =
      (/(?:language-)([\w+#.-]+)/.exec(String(code.className || '')) || [])[1] ||
      code.getAttribute('data-language') ||
      '';
    if (!lang) {
      const block = node.closest && node.closest('[class*="md-code-block"]');
      const banner = block && block.querySelector('[class*="md-code-block-banner"]');
      if (banner) {
        const guess = String(banner.textContent || '')
          .replace(/\s*(复制|下载|copy|download)\s*/gi, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        if (guess && guess.length <= 20 && !guess.includes(' ')) lang = guess.toLowerCase();
      }
    }
    const raw = String(code.textContent || '').replace(/\s+$/, '');
    return `\n\n\`\`\`${lang}\n${raw}\n\`\`\`\n\n`;
  },
});

function htmlToMarkdown(root) {
  if (!root) return '';
  try {
    return turndown
      .turndown(root)
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]+$/gm, '')
      .trim();
  } catch (err) {
    debug(`HTML→Markdown 失败(已忽略): ${err.message}`);
    return String(root.textContent || '').trim();
  }
}

/* ========================================================================== */
/*                     读取「一轮回复」：思考过程 + 正文                        */
/* ========================================================================== */

/**
 * 取最后一条助手回复的【正文】容器。
 *
 * ⚠️ 千万别退回「[class*='markdown'] 取最后一个」—— 实测全页带 markdown 字样的元素有 90 个，
 * 绝大多数是碎片（代码块外壳 md-code-block-banner-wrap 的文本只有 8 个字「bash复制下载」）。
 * 早期就是这么写的，结果面板上只显示出 `-` 和 `34`。
 */
function resolveLatestContent() {
  const input = resolveInput();
  const hits = pickAll('assistantMessage').filter(
    (el) => !isOurs(el) && !(input && el.contains(input))
  );
  if (!hits.length) return null;
  // 命中的可能混进代码块外壳（兜底候选里含通用 markdown），先剔掉
  const clean = hits.filter((el) => !/code-block/i.test(String(el.className)));
  const list = clean.length ? clean : hits;
  return list[list.length - 1];
}

/**
 * 通用兜底：最外层的 markdown 容器（排除嵌套碎片、代码块外壳、思考过程内部的）。
 * 只在严格类名全落空时才走这里。
 */
function fallbackOutermostMarkdown() {
  const input = resolveInput();
  const reasonSels = selectorList('reasoning');
  const inReasoning = (el) =>
    reasonSels.some((s) => {
      try {
        return !!el.closest(s);
      } catch (_) {
        return false;
      }
    });

  const all = Array.from(document.querySelectorAll('[class*="markdown"]'))
    .filter((el) => !isOurs(el))
    .filter((el) => !/code-block/i.test(String(el.className)))
    .filter((el) => !(input && el.contains(input)))
    .filter((el) => !inReasoning(el))
    .filter((el) => isVisible(el) && String(el.textContent || '').trim().length > 20);
  if (!all.length) return null;

  // 只保留不被其它候选包含的（最外层），否则会取到 p.ds-markdown-paragraph 这种碎片
  const outermost = all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
  const list = outermost.length ? outermost : all;
  return list[list.length - 1];
}

/** 在指定范围内找思考过程正文 */
function pickReasoningIn(scope) {
  const root = scope || document;
  for (const sel of selectorList('reasoning')) {
    try {
      const el = root.querySelector(sel);
      if (el && !isOurs(el)) return el;
    } catch (_) {
      /* 单个选择器写错不影响其他候选 */
    }
  }
  return null;
}

/** 找正文所在的「这一轮」容器（思考和正文都在它里面） */
function turnOf(contentEl) {
  if (!contentEl) return null;
  for (const sel of selectorList('assistantTurn')) {
    try {
      const el = contentEl.closest(sel);
      if (el) return el;
    } catch (_) {
      /* ignore */
    }
  }
  return contentEl.parentElement || null; // 兜底：正文的父节点就是这一轮
}

/**
 * 读一轮回复：思考过程（纯文本）+ 正文（Markdown）。
 *
 * 思考过程刻意不转 Markdown：它是推理原文，转换没意义，还容易把
 * 「已思考（用时 N 秒）」那句折叠头一起带进来。
 */
function readLatestTurn() {
  let contentEl = resolveLatestContent();
  if (!contentEl) contentEl = fallbackOutermostMarkdown();
  if (!contentEl) return null;

  const reasoningEl = pickReasoningIn(turnOf(contentEl));
  const content = htmlToMarkdown(contentEl);

  let reasoning = '';
  if (reasoningEl && reasoningEl !== contentEl) {
    reasoning = String(reasoningEl.innerText || reasoningEl.textContent || '').trim();
    // 个别实现会把折叠头塞进同一个容器，去掉它
    reasoning = reasoning.replace(/^\s*(已深度思考|已思考|思考过程)[^\n]*\n?/, '').trim();
  }

  if (!content && !reasoning) return null;

  return {
    content,
    reasoning,
    // 流式输出时两者都在变，长度 + 尾部片段一起当指纹
    key: `${content.length}:${content.slice(-24)}|R${reasoning.length}:${reasoning.slice(-24)}`,
  };
}

/* ========================================================================== */
/*                    监听「最新一条回复」（快捷问答面板用）                     */
/* ========================================================================== */

let answerWatch = null;

function readAnswerSnapshot() {
  return readLatestTurn();
}

function stopAnswerWatch() {
  if (answerWatch && answerWatch.timer) clearInterval(answerWatch.timer);
  if (answerWatch && answerWatch.timeoutTimer) clearTimeout(answerWatch.timeoutTimer);
  answerWatch = null;
}

/**
 * 开始盯着最新回复。
 *
 * 原理：记住「当前最后一条回复」当作基线，之后出现不同的内容就是新答案。
 * 结束判定不看站点的 DOM 状态（那是脆的），而是看**文本是否停止变化**——
 * 1.5 秒内没变化就认为生成完了。这个判据跟站点改版无关，最稳。
 */
function startAnswerWatch() {
  stopAnswerWatch();
  const baseline = readAnswerSnapshot();
  answerWatch = {
    baselineKey: baseline ? baseline.key : '',
    lastKey: '',
    lastChangeAt: Date.now(),
    gotSomething: false,
    timer: null,
    timeoutTimer: null,
  };

  const emit = (snap, done, extra) => {
    ipcRenderer.send('cs:answer', {
      content: snap ? snap.content : '',
      reasoning: snap ? snap.reasoning : '',
      done,
      ...(extra || {}),
    });
  };

  answerWatch.timer = setInterval(() => {
    try {
      if (!answerWatch) return;
      const snap = readAnswerSnapshot();
      if (!snap) return;

      // 还没等到新答案（还是基线那条）
      if (!answerWatch.gotSomething) {
        if (snap.key === answerWatch.baselineKey) return;
        answerWatch.gotSomething = true;
        answerWatch.lastKey = snap.key;
        answerWatch.lastChangeAt = Date.now();
        emit(snap, false);
        return;
      }

      if (snap.key !== answerWatch.lastKey) {
        answerWatch.lastKey = snap.key;
        answerWatch.lastChangeAt = Date.now();
        emit(snap, false);
        return;
      }

      // 稳定即收工。但「还在思考」要有耐心：正文还没出来说明模型在推理，
      // 推理过程里停顿几秒很正常 —— 还用 1.5 秒判定会把思考阶段直接切断。
      const stableMs = snap.content ? 1500 : 12000;
      if (Date.now() - answerWatch.lastChangeAt > stableMs) {
        emit(snap, true);
        stopAnswerWatch();
      }
    } catch (err) {
      debug(`监听回复出错(已忽略): ${err.message}`);
    }
  }, 400);

  // 总超时兜底，别让面板永远转圈
  answerWatch.timeoutTimer = setTimeout(() => {
    if (!answerWatch) return;
    const snap = readAnswerSnapshot();
    emit(snap, true, { timeout: true, gotSomething: answerWatch.gotSomething });
    stopAnswerWatch();
  }, 120000);
}

function copyLatestMarkdown() {
  try {
    const snap = readLatestTurn();
    if (!snap || !snap.content) {
      toast('没有找到可复制的回复');
      return '';
    }
    ipcRenderer.send('cs:clipboard', snap.content);
    toast(`已复制 ${snap.content.length} 字符的 Markdown`);
    return snap.content;
  } catch (err) {
    debug(`转 Markdown 失败(已忽略): ${err.message}`);
    toast('转换失败，已忽略');
    return '';
  }
}

/**
 * 开一个新会话。
 *
 * 刻意不走「点新对话按钮」：实测那个按钮是无标签纯图标，class 和文本都定位不了。
 * 直接回站点首页 —— 首页本身就是新会话，不依赖任何选择器，最稳。
 */
function newChat() {
  try {
    stopAnswerWatch();
    const home = new URL('/', location.href).href;
    if (location.href.split('#')[0] === home) {
      location.reload(); // 已经在首页：刷新一次照样得到干净的新会话
    } else {
      location.href = home;
    }
    return true;
  } catch (err) {
    debug(`新建会话失败: ${err.message}`);
    return false;
  }
}

/* ========================================================================== */
/*                              页内 UI（只加不抢）                             */
/* ========================================================================== */

const FAB_ID = 'cs-fab';

function removeFab() {
  try {
    const el = document.getElementById(FAB_ID);
    if (el) el.remove();
  } catch (_) {
    /* ignore */
  }
}

function toast(message) {
  try {
    let el = document.getElementById('cs-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'cs-toast';
      el.setAttribute('data-cs-ui', '1');
      document.body.appendChild(el);
    }
    el.textContent = message;
    el.classList.add('cs-toast-visible');
    clearTimeout(el._dsTimer);
    el._dsTimer = setTimeout(() => el.classList.remove('cs-toast-visible'), 1800);
  } catch (_) {
    debug(message);
  }
}

/** 判断当前是不是「真正的站点应用页」，避免往错误页/拦截页上贴 UI */
function looksLikeApp() {
  try {
    if (!/^https?:$/.test(location.protocol)) return false;
    // 拦截页 / 错误页通常只有十几个元素
    return document.querySelectorAll('*').length > 200;
  } catch (_) {
    return false;
  }
}

function buildFab() {
  if (!SETTINGS.copyButtons) return;
  // body 还没解析出来是正常情况（配置可能在 DOMContentLoaded 之前就到了），
  // 直接返回，等 MutationObserver 那一轮再补
  if (!document.body) return;
  if (!looksLikeApp()) return; // 别往错误页/拦截页上贴东西
  if (document.getElementById(FAB_ID)) return;
  try {
    const fab = document.createElement('div');
    fab.id = FAB_ID;
    fab.setAttribute('data-cs-ui', '1');

    const mk = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.setAttribute('data-cs-ui', '1');
      b.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          fn();
        } catch (err) {
          debug(`按钮执行失败(已忽略): ${err.message}`);
        }
      });
      return b;
    };

    fab.appendChild(mk('MD', '复制最新回复为 Markdown', copyLatestMarkdown));
    fab.appendChild(
      mk('新的', '开启新对话', () => {
        const el = pick('newChat');
        if (el) {
          el.click();
          return;
        }
        const home = pick('homeLink');
        if (home) {
          home.click();
          return;
        }
        // 实测聊天页的按钮全是无标签图标，靠 class 定位不了「新对话」。
        // 在 / 路径下重新加载就等同于开一个新对话，所以这是最实在的兜底。
        if (location.pathname === '/' || location.pathname === '') {
          location.reload();
        } else {
          location.assign('https://chat.deepseek.com/');
        }
      })
    );
    fab.appendChild(mk('重载', '重新加载页面', () => location.reload()));
    document.body.appendChild(fab);
  } catch (err) {
    debug(`悬浮条注入失败(已忽略): ${err.message}`);
  }
}

/* ========================================================================== */
/*                              拦截页识别                                      */
/* ========================================================================== */

/**
 * WAF / 边缘节点拦截页（例如 "Rate Limit Reached"）的特征。
 * 必须和「站点改版」区分开：被拦时选择器全都不命中是假象，
 * 这时候去改 selectors.json 是白费功夫。
 */
const BLOCK_PATTERNS = [
  /Rate Limit Reached/i,
  /Request Blocked/i,
  /Event ID/i,
  /Too Many Requests/i,
  /Just a moment/i,
  /Access Denied/i,
  /Checking your browser/i,
  /cf-error/i,
  /请求过于频繁/i,
  /访问被拒绝/i,
];

let lastBlockedKey = '';

function detectBlockPage() {
  try {
    if (!/^https?:$/.test(location.protocol)) return null;
    const bodyText = document.body ? document.body.innerText || '' : '';
    const elementCount = document.querySelectorAll('*').length;
    const hay = `${document.title || ''}\n${bodyText}`;
    const hit = BLOCK_PATTERNS.find((p) => p.test(hay));
    const snippet = bodyText.replace(/\s+/g, ' ').slice(0, 300);
    if (hit) return { patternMatched: true, reason: String(hit), elementCount, snippet };
    // 元素数异常少也可能被拦，但 SPA 首屏慢时也会这样 —— 所以不给用户弹横幅，
    // 只上报给主进程记日志，避免误报吓人
    if (elementCount < 60) return { patternMatched: false, reason: `页面元素数异常(${elementCount})`, elementCount, snippet };
    return null;
  } catch (_) {
    return null;
  }
}

function showBlockNotice(info) {
  if (!document.body || !info.patternMatched) return;
  if (document.getElementById('cs-block-notice')) return;
  try {
    const box = document.createElement('div');
    box.id = 'cs-block-notice';
    box.setAttribute('data-cs-ui', '1');

    const title = document.createElement('div');
    title.className = 'cs-block-title';
    title.textContent = '站点返回了风控拦截页 —— 不是这个桌面壳坏了';
    box.appendChild(title);

    const reason = document.createElement('div');
    reason.className = 'cs-block-reason';
    reason.textContent = `命中特征：${info.reason}　|　元素数 ${info.elementCount}`;
    box.appendChild(reason);

    const tip = document.createElement('div');
    tip.className = 'cs-block-tip';
    tip.textContent =
      '排查：① 在普通浏览器里打开同一地址确认网络可用　② 短时间内反复刷新会加重限流，建议等几分钟　③ 详情见日志 chatshell.log';
    box.appendChild(tip);

    const row = document.createElement('div');
    row.className = 'cs-block-actions';

    const retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重新加载';
    retry.setAttribute('data-cs-ui', '1');
    retry.addEventListener('click', () => location.reload());
    row.appendChild(retry);

    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = '复制我的 UA';
    copy.setAttribute('data-cs-ui', '1');
    copy.addEventListener('click', () => {
      ipcRenderer.send('cs:clipboard', navigator.userAgent);
      toast('UA 已复制，方便比对');
    });
    row.appendChild(copy);

    box.appendChild(row);
    document.body.appendChild(box);
  } catch (err) {
    debug(`拦截页提示渲染失败(已忽略): ${err.message}`);
  }
}

function reportIfBlocked() {
  try {
    const info = detectBlockPage();
    if (!info) {
      lastBlockedKey = '';
      return null;
    }
    showBlockNotice(info);
    const key = `${location.href}|${info.reason}`;
    if (key === lastBlockedKey) return info; // 同一状态只上报一次，避免刷日志
    lastBlockedKey = key;
    ipcRenderer.send('cs:blocked', {
      ...info,
      url: location.href,
      ua: navigator.userAgent,
      webdriver: navigator.webdriver === true,
    });
    debug(`上报拦截页: ${info.reason}`);
    return info;
  } catch (_) {
    return null;
  }
}

/* ========================================================================== */
/*                                 设置应用                                     */
/* ========================================================================== */

/**
 * 开关状态挂在 <html> 的 data-* 属性上，**不能用 class**。
 *
 * 踩过的坑：开关类名 `ds-hide-sidebar` 加在 <html> 上，而 selectors.json 里有
 * `[class*='sidebar']` —— 这个类名恰好包含 "sidebar"，于是规则匹配到 <html> 自己，
 * 一条 `display:none !important` 把整页清空。data-* 属性不会被 [class*=...] 命中。
 */
const FLAG_ATTRS = {
  inject: 'data-cs-inject',
  compact: 'data-cs-compact',
  hideSidebar: 'data-cs-hide-sidebar',
  hideExtras: 'data-cs-hide-extras',
};

function applyFlags() {
  try {
    const html = document.documentElement;
    const on = SETTINGS.enabled !== false;
    const set = (name, active) => {
      if (active) html.setAttribute(name, 'on');
      else html.removeAttribute(name);
    };
    set(FLAG_ATTRS.inject, on);
    set(FLAG_ATTRS.compact, on && SETTINGS.compact !== false);
    set(FLAG_ATTRS.hideSidebar, on && SETTINGS.hideSidebar === true);
    set(FLAG_ATTRS.hideExtras, on && SETTINGS.hideExtras !== false);

    // 兜底自愈：万一将来又写出会命中 html/body 的规则，宁可整体关掉注入，
    // 也不能让用户面对一片白屏（看不到任何报错，最难排查）
    if (on) {
      const d = getComputedStyle(html).display;
      if (d === 'none') {
        html.removeAttribute(FLAG_ATTRS.inject);
        html.removeAttribute(FLAG_ATTRS.compact);
        html.removeAttribute(FLAG_ATTRS.hideSidebar);
        html.removeAttribute(FLAG_ATTRS.hideExtras);
        debug('⚠ 注入样式把 <html> 隐藏了，已自动回滚全部注入开关（请检查 inject.css 的隐藏规则）');
      }
    }
  } catch (err) {
    debug(`应用注入开关失败(已忽略): ${err.message}`);
  }
}

function attachKeyHandler() {
  if (keyHandlerAttached) return;
  keyHandlerAttached = true;
  // ★ capture 阶段抢，保证站点拿不到；
  // ★ isComposing / keyCode 229 保护：中文输入法组字状态下的 Enter 绝不吞
  document.addEventListener(
    'keydown',
    (e) => {
      try {
        if (!SETTINGS.enabled || !SETTINGS.ctrlEnterToSend) return;
        if (e.key !== 'Enter') return;
        if (!(e.ctrlKey || e.metaKey)) return;
        if (e.isComposing || e.keyCode === 229 || e.repeat) return;
        e.preventDefault();
        e.stopPropagation();
        clickSend();
      } catch (err) {
        debug(`Ctrl+Enter 处理异常(已忽略): ${err.message}`);
      }
    },
    true
  );
}

function applySettings(next) {
  SETTINGS = { ...DEFAULT_SETTINGS, ...(next || {}) };
  SELECTORS = SELECTORS || {};
  applyFlags();
  if (SETTINGS.enabled !== false && SETTINGS.copyButtons !== false) buildFab();
  else removeFab();
}

/* ========================================================================== */
/*                         自我修复（站点 SPA 重渲染）                          */
/* ========================================================================== */

function watchDom() {
  try {
    let scheduled = false;
    const observer = new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        try {
          if (SETTINGS.enabled === false) return;
          if (document.documentElement.getAttribute(FLAG_ATTRS.inject) !== 'on') applyFlags();
          if (SETTINGS.copyButtons !== false && !document.getElementById(FAB_ID) && document.body) buildFab();
        } catch (_) {
          /* ignore */
        }
      }, 400);
    });
    observer.observe(document.documentElement, { childList: true, subtree: false });
  } catch (_) {
    /* ignore */
  }
}

/* ========================================================================== */
/*                                  启动                                        */
/* ========================================================================== */

function install() {
  if (installed) return;
  installed = true;
  try {
    applySettings(SETTINGS);
    attachKeyHandler();
    watchDom();
    // 拦截页要等首屏渲染完才好判断（SPA 刚加载时元素也很少）
    setTimeout(reportIfBlocked, 2500);
    setTimeout(reportIfBlocked, 7000);
  } catch (err) {
    debug(`注入安装失败(不影响使用): ${err.message}`);
  }
}

try {
  ipcRenderer.on('cs:inject-config', (_event, payload) => {
    try {
      if (payload && payload.selectors) SELECTORS = payload.selectors;
      if (payload && payload.settings) SETTINGS = { ...DEFAULT_SETTINGS, ...payload.settings };
      install();
      applySettings(SETTINGS);
      if (payload && payload.version) debug(`注入配置已应用 v${payload.version}`);
    } catch (err) {
      debug(`应用注入配置失败(已忽略): ${err.message}`);
    }
  });

  ipcRenderer.on('cs:prompt', (_event, payload = {}) => {
    applyPrompt(payload.text || '', payload.submit !== false);
  });

  ipcRenderer.on('cs:copy-latest-markdown', () => copyLatestMarkdown());

  // 快捷问答面板：开始/停止监听最新回复
  ipcRenderer.on('cs:watch-answer', (_event, payload = {}) => {
    if (payload.on === false) stopAnswerWatch();
    else startAnswerWatch();
  });

  // 快捷问答面板：开一个新会话
  ipcRenderer.on('cs:new-chat', () => newChat());

  /**
   * 诊断用：用**真实的解析逻辑**读一遍当前页面上的最新回复并回报。
   *
   * 站点一改版，第一个出问题的就是「读到的内容不对」—— 而注入层的代码在隔离世界里，
   * 外面的 executeJavaScript 调不到它，只能靠这条通道让主进程问它。
   * `npm run probe:chat` 会打开一个历史会话并触发这里，用来验证「思考 / 正文」分离是否正确。
   */
  ipcRenderer.on('cs:debug-read-turn', () => {
    let result;
    try {
      const snap = readLatestTurn();
      const contentEl = resolveLatestContent();
      const turn = turnOf(contentEl);
      const reasonEl = pickReasoningIn(turn);
      result = {
        ok: !!snap,
        contentLen: snap ? snap.content.length : 0,
        reasoningLen: snap ? snap.reasoning.length : 0,
        contentHead: snap ? snap.content.slice(0, 150) : '',
        reasoningHead: snap ? snap.reasoning.slice(0, 150) : '',
        contentElClass: contentEl ? String(contentEl.className).slice(0, 90) : '(未命中)',
        turnClass: turn ? String(turn.className).slice(0, 90) : '(未命中)',
        reasoningElClass: reasonEl ? String(reasonEl.className).slice(0, 90) : '(未命中)',
      };
    } catch (err) {
      result = { ok: false, error: String(err.message || err) };
    }
    ipcRenderer.send('cs:debug-result', result);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', install, { once: true });
  } else {
    install();
  }

  // 告诉主进程「我准备好了」，避免主进程 push 早于监听
  ipcRenderer.send('cs:ready');
} catch (err) {
  // preload 自身出错也绝不能影响页面
  console.error('[ds-preload]', err);
}
