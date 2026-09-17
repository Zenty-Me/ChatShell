'use strict';

const { log } = require('./log');
const { configDefaults } = require('./defaults');

/**
 * 配置迁移。
 *
 * 背景：v1 的 store 会把「合并了默认值的完整配置」写进 config.json，
 * 于是旧默认值被固化在磁盘上，之后改 defaults.js 再也不生效
 * （踩过的实例：改了 UA 默认值 'default' → 'chrome'，运行时却还是 old 行为）。
 * v2 起 store 只写「与默认值的差异」，这里把 v1 遗留被固化的键回收掉。
 *
 * 约定：
 *   - 用 configStore.raw('configVersion') 判断文件真实版本，
 *     不能用 get()（会被新 defaults 顶掉）
 *   - 只在用户可能没显式设置过时才回收（值恰好等于旧默认值才清）
 */

const CURRENT_VERSION = 7;

function migrate(configStore) {
  const rawVersion = configStore.raw('configVersion');
  const from = rawVersion === undefined ? 1 : Number(rawVersion) || 1;

  if (from >= CURRENT_VERSION) return from;

  if (from < 2) {
    // v1 的 userAgentMode 默认值是 'default'（会被 DeepSeek 边缘节点判为非标准浏览器）。
    // 只在它恰好还等于旧默认值时才回收；用户手填了别的值就保持不动。
    if (String(configStore.raw('userAgentMode') || '') === 'default') {
      configStore.reset('userAgentMode');
      log.info('配置迁移 v1→v2：userAgentMode 已回收，跟随新默认值(chrome)');
    } else {
      log.info('配置迁移 v1→v2：userAgentMode 未被固化，无需处理');
    }
  }

  if (from < 3) {
    // v3：清理 v1 全量写盘遗留的冗余键。
    // 旧文件把「合并了默认值的完整配置」都存了下来，这些键会永久压住
    // defaults.js 的后续修改（UA 那次就是这么被坑的）。
    const freed = configStore.compact();
    log.info(`配置迁移 v2→v3：已把 config.json 瘦身为差异形式（释放 ${freed} 字节）`);
  }

  if (from < 4) {
    // v4：默认形态改成「紧凑小窗口 + 置顶 + 隐藏侧栏」。
    //
    // 关键：老 config.json 里存着扁平结构的 window.width/height（往往是 1300×900 这种大窗口），
    // 它会压住新的紧凑默认值 —— 上一次改 UA 默认值时踩的就是这个坑。
    // 所以这里直接把 window 整块丢掉，让新的双档结构（compactSize/expandedSize）生效。
    const rawWindow = configStore.raw('window') || {};
    const flat = Number(rawWindow.width) || 0;
    if (flat > 0 || rawWindow.compactSize === undefined) {
      configStore.reset('window');
      log.info(`配置迁移 v3→v4：窗口切为紧凑小窗口（丢弃旧尺寸 ${flat || '无'}）`);
    }
    // 默认隐藏左侧会话栏（小窗口放不下）
    configStore.set('injection', { ...(configStore.get('injection') || {}), hideSidebar: true });
    log.info('配置迁移 v3→v4：默认隐藏左侧栏、窗口置顶');
  }

  if (from < 5) {
    // v5：修掉「分数 DPI 舍入污染窗口尺寸」的棘轮 bug。
    //
    // 在 175% 这类分数缩放下，请求 480×700 的窗口 getBounds() 会读到 482×703。
    // 那个被舍入的值一旦存进配置，下次启动又按它建窗口、再被撑大一点点 ——
    // 几次启动后窗口就肉眼可见地变大。这里把被污染的尺寸重置回默认值（位置保留）。
    const d = configDefaults.window;
    const cur = configStore.get('window') || {};
    configStore.set('window', {
      ...cur,
      compactSize: { ...d.compactSize },
      expandedSize: { ...d.expandedSize },
    });
    log.info(
      `配置迁移 v4→v5：窗口尺寸重置为 ${d.compactSize.width}×${d.compactSize.height}（修 DPI 舍入棘轮）`
    );
  }

  if (from < 6) {
    // v6：位置重置为「自动居中」。
    // 开发期间反复切紧凑/展开，坐标会被屏幕边界一点点挤偏（实测从 492 漂到 283）。
    // 置 null 后下次启动会按「鼠标所在屏幕上方居中」重新摆放；
    // 用户拖动一次就会写回实际坐标，之后不再被清。
    configStore.set('window', { ...(configStore.get('window') || {}), x: null, y: null });
    log.info('配置迁移 v5→v6：窗口位置重置为自动居中');
  }

  if (from < 7) {
    // v7：关掉页内悬浮条（MD / 新的 / 重载）。
    // 实测它压在正文上（思考过程那一段直接被盖住），而且快捷问答面板已经覆盖了
    // 「快速问一句」的场景，「复制 Markdown」也还有右键菜单那条路径。
    // 所以显式写死为关闭 —— 老 config.json 里可能已经固化了 copyButtons: true。
    const inj = configStore.get('injection') || {};
    configStore.set('injection', { ...inj, copyButtons: false });
    log.info('配置迁移 v6→v7：已关闭页内悬浮条（仍可用右键菜单复制 Markdown）');
  }

  configStore.set('configVersion', CURRENT_VERSION);
  log.info(`配置迁移完成: configVersion ${from} → ${CURRENT_VERSION}`);
  return CURRENT_VERSION;
}

module.exports = { migrate, CURRENT_VERSION };
