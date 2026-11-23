// PKG-1~PKG-4：`package.json` 的 `files` 必须覆盖到所有**会被 import 的**源码文件。
//
// 为什么需要这组测试：
// v0.2.5 加 `lib/discovery/*.js` 时，`files` 里只有 `lib/*.js` —— npm/pnpm 的 glob
// 里 `*` **不跨目录**，于是 8 个 discovery 文件一个都没进 tgz（实测 tgz 内
// `discovery` 命中 0），本地 903 个测试全绿、打包门禁也全绿，因为
// `verify packed artifact` 只检查了一张写死的 essentials 清单。
// 这类「测试从不检查真正发出去的东西」的问题已经让 v0.2.2 / v0.2.3 各炸过一次，
// 所以这里改用**推导**而不是维护清单：凡是 `index.js` / `lib/**.js` 里 import 到的
// 相对路径，都必须落在 `files` 的覆盖范围内。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url)).replace(/[\\/]test$/, '');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

/** 把一条 `files` 模式转成正则 —— npm 的 glob 语义里 `*` 不跨 `/`，`**` 才跨。 */
function patternToRegExp(pattern) {
  let out = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') { out += '.*'; i += 1; } else { out += '[^/]*'; }
    } else if (ch === '?') {
      out += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}

function isCovered(relPath) {
  const posix = relPath.split(sep).join('/');
  return (pkg.files ?? []).some((pattern) => patternToRegExp(pattern).test(posix));
}

/** 递归列出 lib 下所有 .js（不跟随符号链接，跳过 node_modules）。 */
function listLibJs(dir = join(ROOT, 'lib'), acc = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) listLibJs(full, acc);
    else if (name.endsWith('.js')) acc.push(full);
  }
  return acc;
}

/** 从源码里抽出所有相对 import/export 的目标（只关心 `./` 与 `../`）。 */
function relativeImports(source) {
  const hits = new Set();
  const re = /(?:from\s*|import\s*\(\s*|import\s+)['"]((?:\.{1,2}\/)[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(source)) !== null) hits.add(m[1]);
  return [...hits];
}

test('PKG-1 `files` 覆盖 lib 下每一个 .js（含子目录）', () => {
  const files = listLibJs();
  assert.ok(files.length > 30, `lib 下 .js 数量异常偏少：${files.length}`);
  const missing = files
    .map((f) => relative(ROOT, f))
    .filter((rel) => !isCovered(rel));
  assert.deepEqual(missing, [], `这些 lib 文件不会被装进 tgz（files 里缺对应 glob）：\n${missing.join('\n')}`);
});

test('PKG-2 lib/discovery 整个子目录必须在覆盖范围内', () => {
  const dir = join(ROOT, 'lib', 'discovery');
  assert.ok(existsSync(dir), 'lib/discovery 应存在（Phase 1 实现）');
  const names = readdirSync(dir).filter((n) => n.endsWith('.js'));
  assert.ok(names.length >= 8, `lib/discovery 下应有 >=8 个模块，实际 ${names.length}`);
  for (const n of names) {
    assert.ok(isCovered(`lib/discovery/${n}`), `lib/discovery/${n} 不在 files 覆盖范围内`);
  }
});

test('PKG-3 index.js 与 lib 之间互相 import 的每个目标都存在且被覆盖', () => {
  const sources = [join(ROOT, 'index.js'), ...listLibJs()];
  const problems = [];
  for (const file of sources) {
    const src = readFileSync(file, 'utf8');
    for (const spec of relativeImports(src)) {
      // 只校验以 .js 结尾的显式路径；无扩展名的相对引用由 Node 解析规则负责
      if (!spec.endsWith('.js')) continue;
      const target = join(dirname(file), spec);
      const rel = relative(ROOT, target);
      if (!existsSync(target)) { problems.push(`缺失文件 ${rel}（被 ${relative(ROOT, file)} 引用）`); continue; }
      if (!isCovered(rel)) problems.push(`未打包 ${rel}（被 ${relative(ROOT, file)} 引用）`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('PKG-4 发布门禁按工作区实际 lib 文件推导，而不是维护写死清单', () => {
  const publish = readFileSync(join(ROOT, 'scripts', 'publish-release.mjs'), 'utf8');
  // 写死清单必漏：v0.2.5 新增 lib/discovery 时清单里没有它，门禁照样全绿。
  // 所以要求门禁**遍历工作区 lib** 再逐个核对 tgz 内是否存在。
  assert.match(publish, /walkLib\(/, 'publish-release.mjs 应遍历工作区 lib 推导必备文件');
  assert.match(publish, /missingLib/, 'publish-release.mjs 应列出 tgz 里缺失的 lib 模块');
  assert.match(publish, /readdirSync\(dir\)/, 'walkLib 应真正递归列目录');
});
