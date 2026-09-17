'use strict';

/**
 * UA 策略。
 *
 * 【为什么需要这个文件】
 * Electron 的默认 UA 长这样：
 *   Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko)
 *   DeepSeekDesktop/0.1.0 Chrome/152.0.7977.78 Electron/44.4.1 Safari/537.36
 *
 * 其中 `Electron/44.4.1` 和 `<应用名>/0.1.0` 两个 token 是 DeepSeek 边缘节点
 * 判定「非标准浏览器」的直接依据 —— 命中后直接返回 429 + “Rate Limit Reached” 拦截页。
 *
 * 实测（同一 IP、同一时刻、同一个 curl，只换 UA）：
 *   Chrome UA                    → 200 真实页面
 *   Chrome UA + sec-ch-ua 带Electron → 200（客户端提示头不是因素）
 *   Electron UA                  → 429 拦截页
 * 所以只改 UA 就够了，不需要动网络层。
 *
 * 【做法】
 *   'chrome'  (默认) —— 抹掉所有非标准产品 token，并按 Chrome 的 UA 缩减规则
 *                      把 Chrome/152.0.7977.78 压成 Chrome/152.0.0.0，
 *                      最终与同平台真实 Chrome 逐字节一致。
 *   'default'        —— 完全不动，保留 Electron 原生 UA。
 *   userAgent 填了值   —— 优先用它（最后手段）。
 *
 * 注意：这里不做请求头改写，只用 Electron 官方的 app.userAgentFallback /
 * session.setUserAgent，属于标准能力，不碰 webRequest。
 */

const { app } = require('electron');

/** UA 里属于「标准浏览器」的产品 token，其余带版本号的 token 一律视为应用特征抹掉 */
const STANDARD_TOKENS = /^(Mozilla|AppleWebKit|Gecko|Chrome|Safari|Version|Mobile|Edg|EdgA|OPR|CriOS|FxiOS)$/i;

function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉所有带版本号的非标准产品 token（Electron/x、任意应用名/x …） */
function stripAppTokens(ua) {
  return String(ua || '')
    .split(/\s+/)
    .filter((token) => {
      const m = /^([\w.\-]+)\/[\d.]+$/.exec(token);
      if (!m) return true; // 括号、逗号等结构 token 原样保留
      return STANDARD_TOKENS.test(m[1]);
    })
    .join(' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Chrome 自 2023 起做 UA 缩减：桌面端只上报 major.0.0.0。
 * 不做这一步，UA 里出现完整 build 号（152.0.7977.78）本身就是个异常特征。
 */
function applyUaReduction(ua) {
  return String(ua || '').replace(/Chrome\/(\d+)[\d.]*/g, (_m, major) => `Chrome/${major}.0.0.0`);
}

/** 算出真正要用的 UA；返回空字符串表示「不改」 */
function resolveUserAgent(configStore) {
  const explicit = String(configStore.get('userAgent') || '').trim();
  if (explicit) return explicit;

  const mode = String(configStore.get('userAgentMode') || 'chrome').toLowerCase();
  if (mode !== 'chrome') return ''; // 'default' = 保持 Electron 原生 UA

  const base = app.userAgentFallback || '';
  const cleaned = applyUaReduction(stripAppTokens(base));
  // 兜底：万一清理完变得不合法，就退回干净的标准 Chrome UA
  if (!/^Mozilla\/5\.0 /.test(cleaned) || !/Chrome\//.test(cleaned)) {
    const major = String(process.versions.chrome || '0').split('.')[0];
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
  }
  return cleaned;
}

/**
 * 全局生效：改 app.userAgentFallback（之后创建的所有 webContents 都用它），
 * 同时给这个 partition 的 session 也设一遍（覆盖子资源请求）。
 */
function applyGlobally(configStore, session) {
  const ua = resolveUserAgent(configStore);
  if (!ua) return '';
  try {
    app.userAgentFallback = ua;
  } catch (_) {
    /* ignore */
  }
  try {
    if (session && typeof session.setUserAgent === 'function') {
      session.setUserAgent(ua, 'zh-CN,zh;q=0.9,en;q=0.8');
    }
  } catch (_) {
    /* ignore */
  }
  return ua;
}

/** 给自检报告用：当前配置下「预期」的 UA */
function describe(configStore) {
  const explicit = String(configStore.get('userAgent') || '').trim();
  if (explicit) return { mode: 'custom', ua: explicit };
  const mode = String(configStore.get('userAgentMode') || 'chrome').toLowerCase();
  return { mode, ua: mode === 'chrome' ? resolveUserAgent(configStore) : app.userAgentFallback || '' };
}

module.exports = { resolveUserAgent, applyGlobally, describe, stripAppTokens, applyUaReduction, escapeRegExp };
