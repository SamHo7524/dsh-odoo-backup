import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

// v0.4.0 Task 5：界面源码契约。GUI 断言以真渲染（server-role-render.test.js）为准，
// 本文件只锁住「两端同语义 + 三处过滤点」这些源码级不变量。
const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const lib = readFileSync(new URL('../lib/server-role.js', import.meta.url), 'utf8');

test('CRUI-1 两端内联同一判定表达式（防规则漂移）', () => {
  const re = /server\?\.role === 'restore' \? 'restore' : 'backup'/;
  assert.match(client, re, 'client.js 必须内联与 lib 同语义的 roleOf');
  assert.match(lib, re, 'lib/server-role.js 的 roleOf 表达式被改动了？');
});

test('CRUI-2 备份页只渲染备份源、恢复页只渲染恢复目标', () => {
  assert.match(client, /partitionServers\(servers\)/, '必须按用途切分一次');
  assert.match(client, /backupServers\.map\(/, '备份页用 backupServers');
  assert.match(client, /restoreServers\.map\(/, '恢复页用 restoreServers');
  // 反证：裸 servers.map 只应剩服务器页一处（全量列表）。
  const bare = [...client.matchAll(/^\s+servers\.map\(/gm)];
  assert.equal(bare.length, 1, `裸 servers.map 只应剩服务器页一处，实际 ${bare.length} 处`);
});

test('CRUI-3 恢复页与中立化卡片共用同一份恢复目标列表', () => {
  const iNeu = client.indexOf('中立化状态（恢复后是否接管生产）');
  assert.ok(iNeu > 0);
  const seg = client.slice(iNeu, iNeu + 4000);
  assert.match(seg, /restoreServers\.map\(/, '中立化卡片必须用同一份过滤结果');
});

test('CRUI-4 空态解释了「为什么生产不在这里」', () => {
  assert.match(client, /尚未配置「恢复目标」服务器/);
  assert.match(client, /备份源不会出现在这里/);
});

test('CRUI-5 切换到恢复目标需要输入服务器名确认', () => {
  assert.match(client, /roleConfirm/, '必须存在用途切换确认状态');
  assert.match(client, /roleConfirm\.trim\(\) !== \(editingName \|\| draft\.name\)\.trim\(\)/, '必须与服务名比对');
});

test('CRUI-6 新服务器草稿与保存都带 role', () => {
  assert.match(client, /role: 'backup'/, '新服务器草稿默认 backup');
  assert.match(client, /role: draft\.role \?\? 'backup'/, '保存时把表单里的用途写入条目');
});

test('CRUI-7 既有「状态可读」闸保留，但不再声称「因为没有用途标记」', () => {
  assert.match(client, /statusKnown/, 'statusKnown 是另一条独立正确的规则，必须保留');
  assert.doesNotMatch(client, /插件没有\s*\n?\s*\/\/\s*「恢复机 vs 生产机」标记/,
    'v0.4.0 已补上用途标记，这句理由要删掉');
});

test('CRUI-8 组件支持 initialTab 测试缝', () => {
  assert.match(client, /function OdooBackupPanel\(\{ scope, locale, initialTab = 'servers' \}\)/, '真渲染测试需要直接渲染恢复页');
});
