/**
 * v0.2.2 Task 3 — 本地磁盘空间预检（设计规格 §16：下载前要求 ≥ 2×totalBytes）。
 * 额外路径把包从 ~600 MiB 推到 1.5+ GiB，缺预检会在「组装到一半磁盘满」时才炸。
 * 预检不可用（statfs 抛 ENOSYS）时**跳过**，绝不因预检本身阻断备份。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { ensureLocalSpace, LOCAL_SPACE_FACTOR } from '../lib/local-space.js';
import { humanBytes } from '../lib/extra-paths.js';

const src = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');

/** 造一个假的 statfs：返回固定的 bavail/bsize。 */
function fakeStatfs({ bavail, bsize }) {
  return async () => ({ bavail, bsize });
}

const GB = 1024 ** 3;

test('LSP-1 空间不足时拒绝，消息同时给出所需与可用两个可读数字', async () => {
  // bavail=1Mi 块 × bsize=4096 ≈ 4 GiB，小于需求 3 GiB × 2.2 ≈ 6.6 GiB。
  const avail = 1024 ** 2;
  const r = await ensureLocalSpace(
    'K:/Backup/odoo',
    3 * GB,
    { statfs: fakeStatfs({ bavail: avail, bsize: 4096 }) },
  );
  assert.equal(r.ok, false, '需求 3GiB×2.2=6.6GB > 可用 4GiB 时必须拒绝');
  assert.equal(r.requiredBytes, Math.ceil(3 * GB * LOCAL_SPACE_FACTOR));
  assert.equal(r.availableBytes, avail * 4096);
  assert.match(r.message, /本地磁盘不足/);
  assert.ok(r.message.includes(humanBytes(r.requiredBytes)), '消息必须含所需数字');
  assert.ok(r.message.includes(humanBytes(r.availableBytes)), '消息必须含可用数字');
});

test('LSP-2 statfs 不可用（ENOSYS）时跳过，不阻断备份', async () => {
  const statfs = async () => {
    const e = new Error('statfs is not implemented on this platform');
    e.code = 'ENOSYS';
    throw e;
  };
  const r = await ensureLocalSpace('K:/Backup/odoo', 99 * GB, { statfs });
  assert.equal(r.ok, true, '预检本身不可用不得阻断备份');
  assert.equal(r.skipped, true);
});

test('LSP-3 空间充足时放行', async () => {
  const r = await ensureLocalSpace(
    'K:/Backup/odoo',
    3 * GB,
    { statfs: fakeStatfs({ bavail: 20 * GB / 4096, bsize: 4096 }) },
  );
  assert.equal(r.ok, true);
  assert.equal(r.skipped, false);
});

test('LSP-4 预检缺失 bsize/bavail 时跳过（不误判为不足）', async () => {
  const r = await ensureLocalSpace('K:/Backup/odoo', 3 * GB, { statfs: async () => ({}) });
  assert.equal(r.ok, true);
  assert.equal(r.skipped, true);
});

test('LSP-5 runBackup 在下载判定之前调用本地空间预检', () => {
  const precheck = src.indexOf('ensureLocalSpace(');
  const chunkIdx = src.indexOf('shouldChunk(');
  // 调用点可能是 `downloadAll(` 或可注入的 `doDownloadAll(`（v0.2.4 为让集成测试
  // 真的跑到 return 而引入注入点），用宽松匹配避免把注入点误判成「没有下载」。
  const downloadIdx = src.search(/[Dd]ownloadAll\(/);
  assert.ok(precheck > 0, 'runBackup 必须调用 ensureLocalSpace');
  assert.ok(precheck < chunkIdx, '预检必须在 shouldChunk 判定之前');
  assert.ok(precheck < downloadIdx, '预检必须在下载之前');
});
