import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('SRC-1 schema 里有 role 字段且默认 backup', () => {
  assert.match(src, /role:\s*z\b/);
  assert.match(src, /\.default\('backup'\)/);
});

test('SRC-2 /save-servers 在写入前调用 normalizeServerRole', () => {
  const iSave = src.indexOf("route === '/save-servers'");
  assert.ok(iSave > 0, '必须存在 /save-servers 路由');
  const iUpdate = src.indexOf('settings.update(entryId, { servers', iSave);
  assert.ok(iUpdate > iSave, '必须能定位写入点');
  const block = src.slice(iSave, iUpdate);
  assert.match(block, /normalizeServerRole/, '写入前必须校验用途');
  assert.match(block, /roleCheck\.ok/, '必须按校验结果拒绝');
});

test('SRC-3 /save-servers 归一化后的 role 一并写入（不是丢弃）', () => {
  const iSave = src.indexOf("route === '/save-servers'");
  const iUpdate = src.indexOf('settings.update(entryId, { servers', iSave);
  const block = src.slice(iSave, iUpdate + 200);
  assert.match(block, /role:\s*roleCheck\.role/, '必须把归一化后的 role 写回条目');
});
