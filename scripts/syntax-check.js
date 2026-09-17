'use strict';

/**
 * 静态自检：不启动 GUI，先把能抓的错误抓出来。
 *   - 所有 .js 过一遍语法解析
 *   - 所有 .json 过一遍 JSON.parse
 *   - HTML 里引用的 script/link 文件必须真实存在
 *
 *   npm run check
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|json|html)$/i.test(entry.name)) out.push(full);
  }
  return out;
}

let checked = 0;
const problems = [];

const files = [...walk(path.join(ROOT, 'src')), ...walk(path.join(ROOT, 'scripts')), path.join(ROOT, 'package.json')];

for (const file of files) {
  const rel = path.relative(ROOT, file);
  let source = '';
  try {
    source = fs.readFileSync(file, 'utf8');
  } catch (err) {
    problems.push(`${rel}: 读取失败 ${err.message}`);
    continue;
  }

  if (file.endsWith('.js')) {
    try {
      // 只解析不执行：能抓到语法错误、非法 return、括号不配对等问题
      new vm.Script(source, { filename: file });
      checked++;
    } catch (err) {
      problems.push(`${rel}: 语法错误 → ${err.message}`);
    }
  } else if (file.endsWith('.json')) {
    try {
      JSON.parse(source);
      checked++;
    } catch (err) {
      problems.push(`${rel}: JSON 解析失败 → ${err.message}`);
    }
  } else if (file.endsWith('.html')) {
    const refs = [...source.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
    for (const ref of refs) {
      if (/^(https?:|data:|#)/.test(ref)) continue;
      const target = path.join(path.dirname(file), ref);
      if (!fs.existsSync(target)) problems.push(`${rel}: 引用了不存在的文件 ${ref}`);
    }
    checked++;
  }
}

// 打包必需资源
for (const required of [
  path.join('src', 'main', 'index.js'),
  path.join('src', 'preload', 'chrome-preload.js'),
  path.join('src', 'preload', 'site-preload.js'),
  path.join('src', 'preload', 'palette-preload.js'),
  path.join('src', 'inject', 'selectors.json'),
  path.join('src', 'inject', 'inject.css'),
  path.join('build', 'icon.png'),
]) {
  if (!fs.existsSync(path.join(ROOT, required))) problems.push(`缺少必需文件: ${required}`);
}

console.log(`检查了 ${checked} 个文件`);
if (problems.length) {
  console.error(`\n发现 ${problems.length} 个问题：`);
  for (const p of problems) console.error(`  ✗ ${p}`);
  process.exit(1);
}
console.log('✓ 全部通过');
