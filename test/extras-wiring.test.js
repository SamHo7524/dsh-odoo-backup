import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createService } from '../lib/service.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

function makeConfig(serverExtra = {}) {
  return {
    servers: [
      {
        name: 'toogel',
        host: '47.121.205.143',
        port: 22,
        user: 'root',
        keyPath: 'H:/odoo/key/odoo-backup',
        pinnedFingerprint: 'SHA256:abc',
        odooContainer: 'odoo',
        pgContainer: 'pg',
        dbName: 'tg-odoo',
        dataPath: '/data',
        addonsPath: '/addons',
        ...serverExtra,
      },
    ],
    localBackupDir: 'K:/Backup/odoo',
    passphrase: 'pw',
    sshTimeoutMs: 30000,
    transferTimeoutMs: 3600000,
    allowUnencryptedPackage: false,
  };
}

function deps(overrides = {}) {
  const calls = [];
  const base = {
    calls,
    guardHostKey: async () => ({ ok: true, mode: 'pinned' }),
    discover: async () => ({ ok: true, instances: [{ dbName: 'tg-odoo', odooVersion: '19.0' }] }),
    runBackup: async (a) => {
      calls.push(['runBackup', a]);
      return { ok: true, localPath: 'K:/b.tar.enc', bytes: 10, encrypted: true };
    },
    runRestore: async () => ({ ok: true, state: 'COMMITTED' }),
    testConnection: async () => ({ ok: true, system: { os: 'Ubuntu' } }),
    detectFormat: async () => 'dsh-odoo',
    stat: async () => ({ size: 10 }),
    scanHostKey: async () => ({ ok: true, fingerprint: 'SHA256:abc' }),
    pinHostKey: async () => ({ ok: true }),
    readPackageMeta: async () => ({ ok: true }),
    credentials: { resolve: async () => ({ value: 'pw' }) },
    execRemote: async () => ({ code: 0, stdout: 'OK', stderr: '' }),
  };
  return { ...base, ...overrides };
}

/** 让 service 起来，返回它捕获的 runBackup 参数。 */
async function backupArgs(config) {
  let captured = null;
  const d = deps({
    runBackup: async (a) => {
      captured = a;
      return { ok: true, localPath: 'K:/b.tar.enc', bytes: 10, encrypted: true };
    },
  });
  const svc = createService({ config, deps: d });
  await svc.backup('toogel');
  return captured;
}

test('EW-1 服务器上的 extraPaths 会以归一化形式交给 runBackup', async () => {
  const captured = await backupArgs(
    makeConfig({
      extraPaths: [
        { name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'] },
        { name: 'hermes', path: '/root/.hermes' },
      ],
    }),
  );
  assert.ok(Array.isArray(captured.extraPaths), 'runBackup 必须收到 extraPaths');
  assert.deepEqual(captured.extraPaths, [
    { name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'], maxBytes: null },
    { name: 'hermes', path: '/root/.hermes', exclude: [], maxBytes: null },
  ]);
});

test('EW-2 未配置额外路径时传空数组（不影响老配置）', async () => {
  const captured = await backupArgs(makeConfig());
  assert.deepEqual(captured.extraPaths, []);
});

test('EW-3 非法额外路径配置在 runBackup 之前就被拒绝，且原因可读', async () => {
  let called = false;
  const d = deps({
    runBackup: async () => {
      called = true;
      return { ok: true };
    },
  });
  const svc = createService({
    config: makeConfig({ extraPaths: [{ name: 'vault', path: 'relative/path' }] }),
    deps: d,
  });
  await assert.rejects(() => svc.backup('toogel'), (e) => {
    assert.match(e.message, /额外路径/);
    assert.match(e.message, /绝对路径/);
    return true;
  });
  assert.equal(called, false, '配置非法时不得进入 runBackup');
});

test('EW-4 与内置项重名的额外路径被拒绝', async () => {
  const svc = createService({
    config: makeConfig({ extraPaths: [{ name: 'addons', path: '/root/x' }] }),
    deps: deps(),
  });
  await assert.rejects(() => svc.backup('toogel'), /重名/);
});

test('EW-5 backup.js 调用 packExtras，并把 dump 体积作为空间预算输入', async () => {
  const src = await readFile(`${ROOT}lib/backup.js`, 'utf8');
  assert.match(src, /packExtras/, '必须调用 packExtras');
  assert.match(src, /dumpBytes:\s*dumpSize/, '空间预算必须用实际 dump 体积');
  assert.match(src, /extraPaths/, 'runBackup 必须接收 extraPaths');
});

test('EW-6 MANIFEST 里带 extras 数组（记录名称/文件/字节/哈希）', async () => {
  const src = await readFile(`${ROOT}lib/backup.js`, 'utf8');
  assert.match(src, /extras:\s*extrasResult\.extras|extras:\s*extras\b/, 'MANIFEST 必须记录 extras');
  assert.match(src, /formatVersion:\s*'2\.2'/, '新增字段必须提升 manifest 版本，避免老包被误判同构');
});

test('EW-7 Config schema 为服务器提供 extraPaths 四项字段', async () => {
  const src = await readFile(`${ROOT}index.js`, 'utf8');
  assert.match(src, /extraPaths:/, 'Config.servers 必须声明 extraPaths');
  for (const key of ['name', 'path', 'exclude', 'maxBytes']) {
    assert.match(src, new RegExp(`${key}:`), `extraPaths 项必须含 ${key}`);
  }
  assert.match(src, /额外路径/, 'schema 必须有中文说明供设置页显示');
});