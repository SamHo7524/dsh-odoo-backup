/**
 * v0.2.2 Task 4 — 配置 schema 的「额外路径」契约
 *
 * 目标：schemastery 不会把 extraPaths 剥掉，且未配置时归一为 []。
 * 测试环境没有 @deepseek-ai/schemastery（无 node_modules），
 * 因此按本仓库既有约定做两级校验：
 *   1) 源码级：index.js 的 server schema 必须声明 extraPaths 及其子字段；
 *   2) 运行时级：lib/extra-paths.js 的 normalizeExtras 就是 service.js 的校验入口，
 *      用它验证「含 extraPaths 的服务器对象字段被保留、未配置归一为 []」。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { normalizeExtras } from '../lib/extra-paths.js';

const indexSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');
// 源码跨行缩进会打断逐字段正则，先压平空白再匹配。
const indexFlat = indexSrc.replace(/\s+/g, ' ');

test('CXP-1 Config schema 的服务器项声明 extraPaths 字段', () => {
  assert.match(indexFlat, /extraPaths:\s*z\s*\.\s*array\(/,
    'server schema 必须声明 extraPaths，否则保存会被 schemastery 剥字段');
});

test('CXP-2 extraPaths 子项包含 name / path / exclude / maxBytes', () => {
  assert.match(indexFlat, /extraPaths:\s*z\s*\.\s*array\(\s*z\s*\.\s*object\(\s*\{\s*name:\s*z\s*\.\s*string/, '缺少 name');
  assert.match(indexFlat, /path:\s*z\s*\.\s*string/, '缺少 path');
  assert.match(indexFlat, /exclude:\s*z\s*\.\s*array\(z\s*\.\s*string\(\)\)/, '缺少 exclude 数组');
  // v0.2.3：maxBytes 可空，必须是 union([number, const(null)]) —— schemastery 没有 .nullable()。
  assert.match(indexFlat, /maxBytes:\s*z\s*\.\s*union\(\[\s*z\s*\.\s*number\(\),\s*z\s*\.\s*const\(null\)\s*\]\)/,
    '缺少 maxBytes（可空整数需用 z.union([z.number(), z.const(null)])）');
});

test('CXP-3 未配置 extraPaths 时归一为空数组（服务层据此放行）', () => {
  const r = normalizeExtras(undefined);
  assert.equal(r.ok, true);
  assert.deepEqual(r.extras, [], '未配置额外路径必须是空数组，而不是 undefined');
});

test('CXP-4 含 extraPaths 的服务器对象经校验后字段完整保留', () => {
  const input = [{
    name: 'vault',
    path: '/root/Documents/Obsidian Vault',
    exclude: ['.git', '.obsidian'],
    maxBytes: 1024 ** 3,
  }];
  const r = normalizeExtras(input);
  assert.equal(r.ok, true);
  assert.equal(r.extras.length, 1);
  assert.equal(r.extras[0].name, 'vault');
  assert.equal(r.extras[0].path, '/root/Documents/Obsidian Vault');
  assert.deepEqual(r.extras[0].exclude, ['.git', '.obsidian']);
  assert.equal(r.extras[0].maxBytes, 1024 ** 3);
});
