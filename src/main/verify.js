'use strict';

const fs = require('fs');
const { session } = require('electron');
const { log } = require('./log');

/**
 * 第一优先级验证项：登录态到底有没有落到磁盘。
 *
 *   npm run verify:login
 *
 * 输出会同时打到 stdout 和 %APPDATA%/ChatShell/chatshell.log。
 * 判定标准很简单：
 *   - 启动时（还没登录）cookie 数可能是 0
 *   - 手动登录一次 → 完全退出 → 再跑一次，cookie 数应该 > 0
 *   如果两次都是 0，说明登录态没持久化，先别写其他功能，回来查 partition。
 */

function maskName(name) {
  // 只输出 cookie 名字，绝不输出值（防止 token 泄漏到日志）
  return name;
}

async function collect(ctx) {
  const partition = ctx.config.get('site').partition;
  const info = { partition, at: new Date().toISOString() };

  if (!String(partition).startsWith('persist:')) {
    info.fatal =
      'partition 不是 persist: 前缀 —— 这就是登录态每次丢光的直接原因。' +
      '请把 config.json 里的 site.partition 改成 "persist:deepseek"。';
  }

  let ses = null;
  try {
    ses = session.fromPartition(partition);
  } catch (err) {
    info.fatal = `取 session 失败: ${err.message}`;
    return info;
  }

  try {
    if (typeof ses.getStoragePath === 'function') {
      info.storagePath = ses.getStoragePath();
      info.storagePathExists = info.storagePath ? fs.existsSync(info.storagePath) : false;
    }
  } catch (err) {
    info.storagePath = `(不可用: ${err.message})`;
  }

  try {
    const cookies = await ses.cookies.get({});
    const ds = cookies.filter((c) => /deepseek/i.test(c.domain || '') || /deepseek/i.test(c.name || ''));
    const pool = ds.length ? ds : cookies;
    info.cookieTotal = cookies.length;
    info.cookieDeepseek = ds.length;
    info.cookies = pool.slice(0, 40).map((c) => ({
      name: maskName(c.name),
      domain: c.domain,
      expires: c.expirationDate ? new Date(c.expirationDate * 1000).toISOString() : 'session',
    }));
    // 只看名字里带这些关键词的，判定「疑似登录凭证」
    info.suspectAuthCookies = pool
      .filter((c) => /token|session|auth|login|user|ticket|sid/i.test(c.name))
      .map((c) => c.name);
  } catch (err) {
    info.cookieError = err.message;
  }

  // localStorage 层面（登录态有时只存 localStorage）
  try {
    const tabs = ctx.windows ? ctx.windows.allTabs() : [];
    const active = tabs.find((t) => t.active) || tabs[0];
    if (active && !active.view.webContents.isDestroyed()) {
      const ls = await active.view.webContents.executeJavaScript(
        `(() => { try { return { keys: Object.keys(localStorage).length, hasTokenish: Object.keys(localStorage).some(k => /token|auth|user/i.test(k)) }; } catch (e) { return { error: String(e) }; } })()`,
        true
      );
      info.localStorage = ls;
    }
  } catch (_) {
    /* 页面还没就绪就算了 */
  }

  return info;
}

async function runLoginVerification(ctx, phase) {
  const info = await collect(ctx);
  const head = `===== 登录态验证 [${phase}] =====`;
  log.verify(head);
  if (info.fatal) log.verify(`❌ ${info.fatal}`);
  log.verify(`partition      : ${info.partition}`);
  log.verify(`存储目录        : ${info.storagePath} (存在=${info.storagePathExists})`);
  log.verify(`cookie 总数     : ${info.cookieTotal ?? 'n/a'} / deepseek 域: ${info.cookieDeepseek ?? 'n/a'}`);
  if (info.suspectAuthCookies) {
    log.verify(`疑似登录凭证    : ${info.suspectAuthCookies.length ? info.suspectAuthCookies.join(', ') : '（无）'}`);
  }
  log.verify(`localStorage    : ${JSON.stringify(info.localStorage || {})}`);
  if (info.cookieError) log.verify(`cookie 读取异常 : ${info.cookieError}`);
  log.verify(`UA 是否 webdriver: 检查选择器自检报告里的 webdriver 字段（应为 false）`);
  log.verify('================================');
  return info;
}

/**
 * 退出前再打一次，用来和启动时对比。
 * 由 index.js 的 before-quit 调用（那里会先 preventDefault 等打完日志再退，
 * 所以异步的 cookie 读取不会被进程退出打断）。
 */
module.exports = { runLoginVerification, collect };
