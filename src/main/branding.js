'use strict';

/**
 * 品牌信息集中在这里。
 *
 * 为什么要单独一个文件：这个壳的定位是「网页版 AI 的外壳」，以后可能适配
 * Kimi / GLM / 豆包 / ChatGPT 等等，也可能想换个名字。把名字、旧名字、
 * 展示文案收敛到一处，改名就只需要动这里 + package.json 的 productName。
 *
 * ⚠ 改名有个必须处理的副作用：`app.getPath('userData')` 是按应用名推导的，
 *   改名字会换目录 —— 而**登录态就在那个目录里**（Partitions/ 下的 cookie、
 *   Local State 里的加密密钥）。所以这里带了 userData 迁移，见下面。
 */

const fs = require('fs');
const path = require('path');

/** 当前应用名。必须与 package.json 的 productName 一致。 */
const APP_NAME = 'ChatShell';

/** 用过这个名字的用户目录都要能被找到并迁移过来（新→旧顺序无所谓） */
const LEGACY_APP_NAMES = ['DeepSeek Desktop'];

/** UI 里出现品牌名的地方统一从这里取，避免散落各处 */
const BRAND = {
  name: APP_NAME,
  /** 中文名，托盘/关于里用 */
  nameZh: '壳聊',
  /** 标题栏左上角的角标 */
  mark: 'CS',
  tagline: '网页版 AI 的桌面外壳',
};

/**
 * 复制用户目录时跳过的缓存目录。
 * 这些是纯缓存，体积大且可重建；而登录态相关的
 * （Partitions/、Local Storage/、Session Storage/、Network/、Local State）
 * 一个都不能少 —— 尤其是 Local State，它存着 cookie 的加密密钥。
 */
const SKIP_DIRS = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'GpuCache',
  'DawnCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'ShaderCache',
  'GrShaderCache',
  'blob_storage',
  'Crashpad',
  'logs',
]);

function copyFilter(src) {
  const base = path.basename(src);
  if (SKIP_DIRS.has(base)) return false;
  if (/\.log$/i.test(base)) return false;
  return true;
}

/**
 * 确保 userData 目录存在，并在改名后把老目录迁移过来。
 *
 * 必须在 app ready **之前**调用（session 一创建，目录就被锁定了）。
 * 任何失败都只记日志，绝不阻塞启动 —— 大不了重新登录一次，
 * 总比应用起不来好。
 */
function ensureUserData(app) {
  const appData = app.getPath('appData');
  const target = path.join(appData, APP_NAME);
  const result = { target, migratedFrom: null, error: '' };

  try {
    if (fs.existsSync(target)) return result; // 已经是新目录，什么都不用做

    for (const legacy of LEGACY_APP_NAMES) {
      const from = path.join(appData, legacy);
      if (!fs.existsSync(from)) continue;

      fs.cpSync(from, target, { recursive: true, filter: copyFilter });
      result.migratedFrom = legacy;
      break;
    }
  } catch (err) {
    result.error = err.message;
  }

  // 显式指定一次，避免依赖 Electron 对 productName 的推导规则
  try {
    app.setPath('userData', target);
  } catch (err) {
    result.error = result.error || err.message;
  }

  return result;
}

module.exports = { APP_NAME, LEGACY_APP_NAMES, BRAND, ensureUserData };
