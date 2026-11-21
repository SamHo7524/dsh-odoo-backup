/**
 * v0.2.2 Task 6 — 文档契约（六处同步）。
 *
 * 双 README 必须有「额外路径 / Extra Paths」章节 + 不自动恢复边界 + `./` 锚定语义；
 * 双 CHANGELOG 必须有当前版本段；README 版本行必须与 package.json 一致。
 *
 * 版本号从 package.json 动态读取（不硬编码），这样发版只改一处，测试不会假红。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const pkg = JSON.parse(read('package.json'));
const V = pkg.version;
const V_RE = V.replaceAll('.', '\\.');

test('DOC-1 package.json 版本号格式合法', () => {
  assert.match(V, /^\d+\.\d+\.\d+$/, `版本号格式应为 x.y.z，实际 ${V}`);
});

test('DOC-2 中文 README 含额外路径章节、排除锚定语义与不自动恢复边界', () => {
  const zh = read('README.zh-CN.md');
  assert.match(zh, /额外路径/, '中文 README 必须有额外路径章节');
  assert.match(zh, new RegExp(`当前版本[：:]\\s*\`${V_RE}\``), '中文 README 版本行必须与 package.json 一致');
  assert.match(zh, new RegExp(`#v${V_RE}`), '中文 README 安装 spec 必须是当前版本');
  assert.match(zh, /--exclude=|排除/, '必须说明排除集的用法');
  assert.match(zh, /tar -x|手工恢复|不自动恢复/, '必须说明本版不做自动恢复');
});

test('DOC-3 英文 README 含 Extra Paths 章节、锚定语义与不自动恢复边界', () => {
  const en = read('README.md');
  assert.match(en, /Extra Path/i, '英文 README 必须有 Extra Paths 章节');
  assert.match(en, new RegExp(`Current version[：:]\\s*\`${V_RE}\``), '英文 README 版本行必须与 package.json 一致');
  assert.match(en, new RegExp(`#v${V_RE}`), '英文 README 安装 spec 必须是当前版本');
  assert.match(en, /--exclude=|exclude/i, '必须说明排除集');
  assert.match(en, /tar -x|manual restore|not automatically restored|no automatic restore/i,
    '必须说明本版不做自动恢复');
});

test('DOC-4 中文 CHANGELOG 顶部条目是当前版本且记录额外路径与 fail-closed', () => {
  const zh = read('CHANGELOG.zh-CN.md');
  const top = (zh.match(/## \[([\d.]+)\]/) || [])[1];
  assert.equal(top, V, `中文 CHANGELOG 顶部条目应为当前版本 ${V}，实际 ${top}`);
  assert.match(zh, /额外路径/, '必须说明新增能力');
  assert.match(zh, /fail-closed|失败即拒绝/, '必须记录 fail-closed 取舍');
});

test('DOC-5 英文 CHANGELOG 顶部条目是当前版本', () => {
  const en = read('CHANGELOG.md');
  const top = (en.match(/## \[([\d.]+)\]/) || [])[1];
  assert.equal(top, V, `英文 CHANGELOG 顶部条目应为当前版本 ${V}，实际 ${top}`);
  assert.match(en, /Extra Path|extra path/i, '必须说明新增能力');
});
