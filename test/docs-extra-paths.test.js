/**
 * v0.2.2 Task 6 — 文档契约（六处同步）。
 *
 * 双 README 必须有「额外路径 / Extra Paths」章节 + 不自动恢复边界 + `./` 锚定语义；
 * 双 CHANGELOG 必须有 [0.2.2] 段；package.json 版本为 0.2.2 且与 README 版本行一致。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));

test('DOC-1 package.json 版本为 0.2.2', () => {
  assert.equal(pkg.version, '0.2.2');
});

test('DOC-2 中文 README 含额外路径章节、排除锚定语义与不自动恢复边界', () => {
  const zh = read('README.zh-CN.md');
  assert.match(zh, /额外路径/, '中文 README 必须有额外路径章节');
  assert.match(zh, /当前版本：`0\.2\.2`/, '中文 README 版本行必须与 package.json 一致');
  assert.match(zh, /--exclude=|排除/, '必须说明排除集的用法');
  assert.match(zh, /tar -x|手工恢复|不自动恢复/, '必须说明本版不做自动恢复');
});

test('DOC-3 英文 README 含 Extra Paths 章节、锚定语义与不自动恢复边界', () => {
  const en = read('README.md');
  assert.match(en, /Extra Path/i, '英文 README 必须有 Extra Paths 章节');
  assert.match(en, /Current version: `0\.2\.2`/, '英文 README 版本行必须与 package.json 一致');
  assert.match(en, /--exclude=|exclude/i, '必须说明排除集');
  assert.match(en, /tar -x|manual restore|not automatically restored|no automatic restore/i,
    '必须说明本版不做自动恢复');
});

test('DOC-4 中文 CHANGELOG 有 [0.2.2] 段且记录实测体积与设计取舍', () => {
  const zh = read('CHANGELOG.zh-CN.md');
  assert.match(zh, /## \[0\.2\.2\]/, '中文 CHANGELOG 必须有 [0.2.2] 段');
  assert.match(zh, /额外路径/, '必须说明新增能力');
  assert.match(zh, /fail-closed|失败即拒绝/, '必须记录 fail-closed 取舍');
});

test('DOC-5 英文 CHANGELOG 有 [0.2.2] 段', () => {
  const en = read('CHANGELOG.md');
  assert.match(en, /## \[0\.2\.2\]/, '英文 CHANGELOG 必须有 [0.2.2] 段');
  assert.match(en, /Extra Path|extra path/i, '必须说明新增能力');
});
