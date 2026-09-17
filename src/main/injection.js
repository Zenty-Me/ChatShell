'use strict';

const fs = require('fs');
const path = require('path');
const { PATHS } = require('./paths');
const { log } = require('./log');

/**
 * 注入层的「主进程侧」。只做两件事：
 *   1) 把 selectors.json + 用户配置推给站点页的 preload；
 *   2) 把 inject.css 用 insertCSS 打进去（insertCSS 是按 document 生效的，
 *      所以每次导航后都要重新打一次）。
 *
 * 真正的 DOM 操作全在 src/preload/site-preload.js 里，且要求「选不到就静默 return」。
 */

const state = {
  selectors: { version: 1, groups: {} },
  cssRaw: '',
  css: '',
  cssKeyByContents: new Map(), // webContents.id -> inserted CSS key
  appliedByContents: new Map(), // webContents.id -> config signature
  siteCssWarned: false,
};

function loadSelectors() {
  try {
    const raw = fs.readFileSync(path.join(PATHS.inject, 'selectors.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && parsed.groups) {
      state.selectors = parsed;
      log.info(`selectors.json 已加载，共 ${Object.keys(parsed.groups).length} 组选择器`);
    } else {
      log.warn('selectors.json 结构不对，忽略');
    }
  } catch (err) {
    log.error(`selectors.json 读取失败(${err.message})，注入层将只做静默兜底`);
  }
  return state.selectors;
}

/** 把 selectors.json 的候选渲染成 CSS 选择器串；空组渲染成永假选择器 */
function selectorsToCss(groupName) {
  const spec = (state.selectors.groups || {})[groupName];
  const list = Array.isArray(spec) ? spec : (spec && spec.selectors) || [];
  const clean = list.filter((s) => typeof s === 'string' && s.trim());
  return clean.length ? clean.join(',\n') : '.cs-never-match';
}

/**
 * 读到 CSS 模板后，把 {{group}} 占位符替换成真实选择器。
 * 这样「改站点适配」只需要编辑 selectors.json，不用碰 CSS/JS。
 */
function renderCss() {
  return state.cssRaw.replace(/\{\{\s*([\w-]+)\s*\}\}/g, (_m, name) => selectorsToCss(name));
}

function loadCss() {
  try {
    state.cssRaw = fs.readFileSync(path.join(PATHS.inject, 'inject.css'), 'utf8');
  } catch (err) {
    state.cssRaw = '';
    if (!state.siteCssWarned) {
      state.siteCssWarned = true;
      log.warn(`inject.css 读取失败: ${err.message}`);
    }
  }
  state.css = renderCss();
  return state.css;
}

/** 进程启动时加载一次 */
function init() {
  loadSelectors();
  loadCss();
}

function reload() {
  init();
  for (const wc of state.cssKeyByContents.keys()) {
    // 标记失效，下次 applyTo 会重新插入
    state.appliedByContents.delete(wc);
  }
}

function buildPayload(configStore) {
  const inj = configStore.get('injection') || {};
  return {
    version: state.selectors.version || 1,
    selectors: state.selectors.groups || {},
    settings: {
      enabled: inj.enabled !== false,
      compact: inj.compact !== false,
      hideSidebar: inj.hideSidebar === true,
      hideExtras: inj.hideExtras !== false,
      ctrlEnterToSend: inj.ctrlEnterToSend !== false,
      copyButtons: inj.copyButtons !== false,
    },
  };
}

/**
 * 把注入层应用到某个站点 webContents。
 * 注意：任何一步失败都只记日志，不影响页面本身。
 */
function applyTo(webContents, configStore) {
  if (!webContents || webContents.isDestroyed()) return;
  const id = webContents.id;

  // 1) CSS（每次导航后 document 是新的，必须重插）
  if (state.css) {
    try {
      webContents
        .insertCSS(state.css, { cssOrigin: 'user' })
        .then((key) => {
          const old = state.cssKeyByContents.get(id);
          if (old && old !== key) {
            webContents.removeInsertedCSS(old).catch(() => {});
          }
          state.cssKeyByContents.set(id, key);
        })
        .catch(() => {});
    } catch (_) {
      /* 静默 */
    }
  }

  // 2) 选择器 + 功能开关推给 preload
  try {
    const payload = buildPayload(configStore);
    webContents.send('cs:inject-config', payload);
    state.appliedByContents.set(id, `${payload.version}:${JSON.stringify(payload.settings)}`);
  } catch (err) {
    log.warn(`推送注入配置失败: ${err.message}`);
  }
}

/** 给站点页一个「重放当前配置」的机会（preload 就绪时会主动要一次） */
function replay(webContents, configStore) {
  applyTo(webContents, configStore);
}

/**
 * 选择器自检：站点改版导致按钮失效时，用它快速定位该改哪一组。
 * 除了逐条报告命中数，还会顺手采集一份「DOM 指纹」——
 * 页面上真实存在的 textarea / contenteditable / 按钮标签 / 高频 class，
 * 这样改 selectors.json 不用去猜，直接照抄。
 */
async function diagnose(webContents) {
  const groups = state.selectors.groups || {};
  const script = `(() => {
    const groups = ${JSON.stringify(groups)};
    const out = {};
    for (const [name, spec] of Object.entries(groups)) {
      const list = Array.isArray(spec) ? spec : (spec && spec.selectors) || [];
      const rows = [];
      for (const sel of list) {
        let n = 0;
        let err = '';
        try { n = document.querySelectorAll(sel).length; } catch (e) { err = String(e.message || e); }
        rows.push({ selector: sel, count: n, error: err });
      }
      // 文本关键词兜底（按钮没有稳定 class 时用），一并报告命中情况
      const kws = (spec && Array.isArray(spec.textKeywords)) ? spec.textKeywords : [];
      if (kws.length) {
        const tags = 'button, [role="button"], a[href], [class*="button"], [class*="btn"]';
        let hitEl = null;
        try {
          const cands = Array.from(document.querySelectorAll(tags))
            .filter((el) => !el.closest('[data-cs-ui]'))
            .filter((el) => { const r = el.getBoundingClientRect(); return r.width > 2 && r.height > 2; });
          const lower = kws.map((k) => String(k).toLowerCase());
          const label = (el) => String((el.getAttribute('aria-label') || '') || el.textContent || '').replace(/\\s+/g, ' ').trim();
          hitEl = cands.find((el) => lower.includes(label(el).toLowerCase())) ||
                  cands.find((el) => { const l = label(el).toLowerCase(); return l && l.length <= 4 && lower.some((k) => l.includes(k)); }) ||
                  null;
        } catch (e) { /* ignore */ }
        rows.push({
          selector: 'text:' + kws.join('|'),
          count: hitEl ? 1 : 0,
          error: '',
          matchedText: hitEl ? String((hitEl.getAttribute('aria-label') || '') || hitEl.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 30) : '',
        });
      }
      out[name] = { matched: rows.some((r) => r.count > 0), rows };
    }

    // ---- DOM 指纹：用来修选择器 ----
    const brief = (el) => ({
      tag: el.tagName.toLowerCase(),
      id: el.id || '',
      cls: String(el.className || '').slice(0, 120),
      type: el.getAttribute('type') || '',
      role: el.getAttribute('role') || '',
      aria: el.getAttribute('aria-label') || '',
      title: el.getAttribute('title') || '',
      href: el.getAttribute('href') || '',
      placeholder: el.getAttribute('placeholder') || '',
      text: (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40),
    });
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      return r.width > 2 && r.height > 2;
    };

    const probes = {};
    probes.textareas = Array.from(document.querySelectorAll('textarea')).slice(0, 10).map(brief);
    probes.contentEditables = Array.from(document.querySelectorAll('[contenteditable="true"]'))
      .slice(0, 10).map(brief);
    probes.buttons = Array.from(document.querySelectorAll('button, [role="button"]'))
      .filter(visible).slice(0, 40).map(brief);
    probes.links = Array.from(document.querySelectorAll('a[href]'))
      .filter(visible).slice(0, 20).map(brief);

    // 高频 class token：站点改版后通常能从这里看出新的命名规律
    const counter = new Map();
    for (const el of document.querySelectorAll('[class]')) {
      const raw = el.getAttribute('class') || '';
      for (const token of raw.split(/\\s+/)) {
        if (!token || token.length > 40) continue;
        counter.set(token, (counter.get(token) || 0) + 1);
      }
    }
    probes.topClasses = Array.from(counter.entries())
      .sort((a, b) => b[1] - a[1]).slice(0, 60)
      .map(([name, count]) => ({ name, count }));

    // ---- 拦截页识别 ----
    // 关键：被 WAF/边缘节点拦下来时页面只有十几个元素，此时"所有选择器都未命中"
    // 是假象，不是站点改版。必须把它和"真的改版了"区分开，否则会带着人去改错地方。
    const BLOCK_PATTERNS = [
      /Rate Limit Reached/i, /Request Blocked/i, /Event ID/i, /Too Many Requests/i,
      /Just a moment/i, /Access Denied/i, /Checking your browser/i, /cf-error/i,
      /请求过于频繁/i, /访问被拒绝/i
    ];
    const bodyText = (document.body ? document.body.innerText : '') || '';
    const elementCount = document.querySelectorAll('*').length;
    const hay = document.title + '\\n' + bodyText;
    const blockHit = BLOCK_PATTERNS.find((p) => p.test(hay));
    const blocked = !!blockHit || elementCount < 60;

    // 页面种类：没登录时是登录页，composer/sendButton 这些组本来就不该命中，
    // 不能把它当成"选择器过期"，否则会带着用户去改错东西
    const hasComposer = document.querySelectorAll('textarea, [contenteditable="true"]').length > 0;
    let pageKind = 'unknown';
    if (hasComposer) pageKind = 'chat';
    else if (/sign_?in|login|passport/i.test(location.pathname) || /验证码|扫码登录|密码登录|Sign in/i.test(bodyText)) pageKind = 'signin';

    // ---- 注入层自伤检测 ----
    // 踩过的坑：开关类名 ds-hide-sidebar 加在 <html> 上，而选择器里有 [class*='sidebar']，
    // 属性值恰好包含 "sidebar" → 规则命中 <html> → display:none → 整页纯白。
    // 这种「注入层把页面自己藏了」的问题必须能被自动抓到，否则只能靠用户报「白屏」。
    const htmlStyle = getComputedStyle(document.documentElement);
    const bodyStyle = document.body ? getComputedStyle(document.body) : null;
    const htmlRect = document.documentElement.getBoundingClientRect();
    const rootEl = document.querySelector('#root');
    const rootRect = rootEl ? rootEl.getBoundingClientRect() : null;
    const selfHiddenReasons = [];
    if (htmlStyle.display === 'none') selfHiddenReasons.push('html 被 display:none');
    if (htmlStyle.visibility === 'hidden') selfHiddenReasons.push('html 被 visibility:hidden');
    if (bodyStyle && bodyStyle.display === 'none') selfHiddenReasons.push('body 被 display:none');
    if (htmlRect.width === 0 && htmlRect.height === 0) selfHiddenReasons.push('html 尺寸为 0');
    if (rootRect && rootRect.width === 0 && rootRect.height === 0) selfHiddenReasons.push('#root 尺寸为 0');
    const flags = {};
    ['data-cs-inject', 'data-cs-compact', 'data-cs-hide-sidebar', 'data-cs-hide-extras'].forEach((a) => {
      flags[a] = document.documentElement.getAttribute(a) || '';
    });

    return {
      url: location.href,
      title: document.title,
      pageKind: pageKind,
      ua: navigator.userAgent,
      uaBrands: (navigator.userAgentData && navigator.userAgentData.brands || [])
        .map((b) => b.brand + '/' + b.version).join(', '),
      webdriver: navigator.webdriver === true,
      blocked: blocked,
      blockedReason: blockHit ? String(blockHit) : blocked ? '页面元素数异常(' + elementCount + ')' : '',
      blockedSnippet: bodyText.replace(/\\s+/g, ' ').slice(0, 300),
      selfHidden: selfHiddenReasons.length > 0,
      selfHiddenReasons: selfHiddenReasons,
      injectFlags: flags,
      bodyText: bodyText.slice(0, 600),
      elementCount: elementCount,
      groups: out,
      probes,
    };
  })()`;

  let report;
  try {
    report = await webContents.executeJavaScript(script, true);
  } catch (err) {
    report = { error: String(err.message || err), groups: {}, probes: {} };
  }
  report.checkedAt = new Date().toISOString();
  try {
    fs.writeFileSync(PATHS.selectorReport, JSON.stringify(report, null, 2), 'utf8');
    log.info(`选择器自检完成，报告: ${PATHS.selectorReport}`);
  } catch (err) {
    log.warn(`自检报告写盘失败: ${err.message}`);
  }
  return report;
}

module.exports = { init, reload, applyTo, replay, diagnose, state, loadSelectors };
