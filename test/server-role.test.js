import { test } from 'node:test';
import assert from 'node:assert';
import {
  SERVER_ROLES,
  ROLE_LABELS,
  normalizeServerRole,
  roleOf,
  canBackup,
  canRestore,
  assertBackupServer,
  assertRestoreTarget,
  partitionServers,
} from '../lib/server-role.js';

// ---------------- 写入时严格校验 ----------------

test('SR-1 缺失/空串 → backup（安全侧默认）', () => {
  for (const v of [undefined, null, '']) {
    assert.deepEqual(normalizeServerRole(v), { ok: true, role: 'backup' });
  }
});

test('SR-2 两个合法值原样通过', () => {
  assert.deepEqual(normalizeServerRole('backup'), { ok: true, role: 'backup' });
  assert.deepEqual(normalizeServerRole('restore'), { ok: true, role: 'restore' });
  assert.deepEqual(normalizeServerRole('  restore  '), { ok: true, role: 'restore' });
});

test('SR-3 拼错/大小写/非字符串 → 拒绝保存（不是静默降级）', () => {
  for (const v of ['RESTORE', 'Restore', 'restroe', 'prod', 1, true, {}, []]) {
    const r = normalizeServerRole(v);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(v)}`);
    assert.match(r.reason, /backup|restore/);
  }
});

// ---------------- 运行时判定（容错方向） ----------------

test('SR-4 roleOf 只认精确 restore，其余全按 backup', () => {
  assert.equal(roleOf({ role: 'restore' }), 'restore');
  assert.equal(roleOf({ role: 'backup' }), 'backup');
  for (const v of [undefined, null, '', 'RESTORE', 'Restore', 'restroe', 1, true, {}]) {
    assert.equal(roleOf({ role: v }), 'backup', `必须落到安全侧：${JSON.stringify(v)}`);
  }
  assert.equal(roleOf(undefined), 'backup');
  assert.equal(roleOf(null), 'backup');
});

test('SR-5 roleOf 不修改入参（冻结对象不抛错，前后深相等）', () => {
  const s = Object.freeze({ name: 'toogel', role: 'restore', extra: Object.freeze({ a: 1 }) });
  const before = JSON.stringify(s);
  assert.equal(roleOf(s), 'restore');
  assert.equal(JSON.stringify(s), before);
  assert.equal(roleOf(s), 'restore', '第二次调用不能因为「自动修复」而改变结果');
});

test('SR-6 canBackup / canRestore 互斥', () => {
  assert.equal(canBackup({ role: 'backup' }), true);
  assert.equal(canRestore({ role: 'backup' }), false);
  assert.equal(canBackup({ role: 'restore' }), false);
  assert.equal(canRestore({ role: 'restore' }), true);
});

// ---------------- 断言文案 ----------------

test('SR-7 对恢复目标备份 → 抛错，含服务器名与「用途」', () => {
  assert.throws(
    () => assertBackupServer({ name: 'odoo.toogel.cn', role: 'restore' }),
    (e) => /odoo\.toogel\.cn/.test(e.message) && /用途/.test(e.message) && /快照/.test(e.message),
  );
});

test('SR-8 对备份源恢复 → 抛错，含服务器名、「用途」与破坏性说明', () => {
  assert.throws(
    () => assertRestoreTarget({ name: 'toogel', role: 'backup' }),
    (e) => /toogel/.test(e.message) && /用途/.test(e.message) && /RENAME|覆盖/.test(e.message),
  );
});

test('SR-9 合法用途返回原对象（便于链式取配置）', () => {
  const a = { name: 'a', role: 'backup' };
  assert.equal(assertBackupServer(a), a);
  const b = { name: 'b', role: 'restore' };
  assert.equal(assertRestoreTarget(b), b);
});

test('SR-10 未命名服务器也能给出可读文案', () => {
  assert.throws(() => assertRestoreTarget({}), /未命名服务器/);
});

// ---------------- 分类 ----------------

test('SR-11 partitionServers 保持顺序、两类不交叉', () => {
  const list = [
    { name: 'p1', role: 'backup' },
    { name: 'r1', role: 'restore' },
    { name: 'n1' },
    { name: 'r2', role: 'restore' },
    { name: 'p2', role: 'backup' },
  ];
  const { backup, restore } = partitionServers(list);
  assert.deepEqual(backup.map((s) => s.name), ['p1', 'n1', 'p2']);
  assert.deepEqual(restore.map((s) => s.name), ['r1', 'r2']);
});

test('SR-12 partitionServers 对脏输入不崩', () => {
  for (const bad of [undefined, null, 'x', 1, {}]) {
    assert.deepEqual(partitionServers(bad), { backup: [], restore: [] });
  }
});

test('SR-13 常量自洽', () => {
  assert.deepEqual(SERVER_ROLES, ['backup', 'restore']);
  assert.deepEqual(Object.keys(ROLE_LABELS).sort(), ['backup', 'restore']);
});
