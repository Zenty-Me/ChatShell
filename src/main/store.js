'use strict';

const fs = require('fs');
const path = require('path');

/**
 * 极简 JSON 持久化：同步写、原子替换、坏文件不炸。
 *
 * ★ 关键设计：磁盘上只存「与默认值不同的部分」(overlay)，不存合并结果。
 *
 *   为什么？如果直接把合并后的完整对象写盘，那么 defaults.js 里任何一次
 *   默认值修改都会被旧文件里的同名字段永久压住 —— 表现为「我明明改了默认值，
 *   运行时却还是老行为」。这个坑在调 UA 策略时真踩过一次。
 *
 *   所以：写盘 = diff(defaults)，读盘 = merge(defaults, overlay)。
 *   只有用户显式改过的叶子节点才会落盘，默认值永远可以随版本演进。
 */

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 深拷贝（值都是 JSON 可序列化的，够用） */
function clone(v) {
  return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
}

/** 把 obj 中和 base 相同的部分裁掉，只留下真正的“差异” */
function diffAgainst(obj, base) {
  if (!isPlainObject(obj)) return clone(obj);
  const out = {};
  for (const [key, value] of Object.entries(obj)) {
    const ref = isPlainObject(base) ? base[key] : undefined;
    if (isPlainObject(value) && isPlainObject(ref)) {
      const sub = diffAgainst(value, ref);
      if (Object.keys(sub).length) out[key] = sub;
    } else if (JSON.stringify(value) !== JSON.stringify(ref)) {
      out[key] = clone(value);
    }
  }
  return out;
}

/** overlay 覆盖在 defaults 上，深合并 */
function mergeDefaults(base, overlay) {
  const out = clone(base) || {};
  if (!isPlainObject(overlay)) return out;
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergeDefaults(out[key], value);
    else out[key] = clone(value);
  }
  return out;
}

class JsonStore {
  constructor(file, defaults = {}) {
    this.file = file;
    this.defaults = clone(defaults) || {};
    this.overlay = this._readOverlay(); // 磁盘上的差异部分
    this.data = mergeDefaults(this.defaults, this.overlay); // 运行时实际生效的完整配置
  }

  _readOverlay() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (isPlainObject(parsed)) return parsed;
    } catch (err) {
      if (err.code !== 'ENOENT') {
        // 文件坏了也不能让应用起不来，退化成默认值并备份坏文件
        try {
          fs.renameSync(this.file, `${this.file}.broken`);
        } catch (_) {
          /* ignore */
        }
      }
    }
    return {};
  }

  get(key, fallback) {
    const value = key ? this.data[key] : this.data;
    return value === undefined ? fallback : value;
  }

  all() {
    return this.data;
  }

  /**
   * 读「磁盘上显式存的值」，不看 defaults。
   * 配置迁移要靠它判断真实的文件版本 —— 直接 get() 会被新 defaults 里的
   * configVersion 顶掉，导致老文件看起来已经是新版。
   */
  raw(key) {
    return key ? this.overlay[key] : this.overlay;
  }

  /**
   * 写入后**重算整个 overlay**（overlay = diff(生效配置, defaults)）。
   *
   * 为什么不增量改 overlay：改成默认值时要能把那个键删掉，增量合并做不到，
   * 会留下过期的显式值继续压住 defaults。整体重算最省心，对象很小，开销可忽略。
   */
  _commit(next) {
    this.data = next;
    this.overlay = diffAgainst(this.data, this.defaults);
    this.save();
    return this.data;
  }

  set(key, value) {
    return this._commit(mergeDefaults(this.data, { [key]: value }));
  }

  patch(partial) {
    return this._commit(mergeDefaults(this.data, partial));
  }

  /** 抹掉显式值，让该键重新跟随 defaults（用于默认值变更后的一次性迁移） */
  reset(key) {
    const next = clone(this.data) || {};
    delete next[key];
    // 注意要用 defaults 把删掉的键补回来，而不是留着空洞
    return this._commit(mergeDefaults(this.defaults, next));
  }

  /**
   * 把 overlay 里「其实等于默认值」的键裁掉。
   * 因为 _commit 已经是整体重算，正常情况下 compact() 无事可做；
   * 保留它是为了兜底清理历史上被全量写盘固化的文件。返回释放的字节数。
   */
  compact() {
    const before = JSON.stringify(this.overlay).length;
    this.overlay = diffAgainst(this.data, this.defaults);
    const after = JSON.stringify(this.overlay).length;
    if (after !== before) this.save();
    return before - after;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.overlay, null, 2), 'utf8');
      fs.renameSync(tmp, this.file); // 原子替换，避免半截文件
    } catch (err) {
      console.error('[store] 写入失败:', this.file, err.message);
    }
  }
}

module.exports = { JsonStore, diffAgainst, mergeDefaults };
