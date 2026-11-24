/**
 * v0.2.9 — 加密单文件从配置到备份包的接线验证。
 *
 * 为什么单独一个文件：`extra-files.test.js` 只证明纯函数对；`extras-wiring.test.js`
 * 只证明 extraPaths 那条链路通。**「字段存住了、也算对了、但没人把它传给 runBackup」**
 * 是这个仓库踩过两次的坑（v0.2.2 入口未 import、v0.2.6 打包漏子目录），
 * 所以这里逐段断言「谁把什么交给了谁」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createService } from '../lib/service.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const ATT_ENV = '/opt/1panel/runtime/python/attendance/.env';
const ATT_RUN = '/opt/1panel/runtime/python/attendance/run.sh';

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
  const base = {
    guardHostKey: async () => ({ ok: true, mode: 'pinned' }),
    discover: async () => ({ ok: true, instances: [{ dbName: 'tg-odoo', odooVersion: '19.0' }] }),
    runBackup: async () => ({ ok: true, localPath: 'K:/b.tar.enc', bytes: 10, encrypted: true }),
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

async function captureBackupArgs(config) {
  let captured = null;
  const svc = createService({
    config,
    deps: deps({
      runBackup: async (a) => {
        captured = a;
        return { ok: true, localPath: 'K:/b.tar.enc', bytes: 10, encrypted: true };
      },
    }),
  });
  await svc.backup('toogel');
  return captured;
}

// ---------------- EFW：服务层传递 ----------------

test('EFW-1 服务器上的 extraFiles 会以 {path}[] 形式交给 runBackup', async () => {
  const a = await captureBackupArgs(makeConfig({
    extraFiles: [{ path: ATT_ENV }, { path: ATT_RUN }],
  }));
  assert.deepEqual(a.extraFiles, [{ path: ATT_ENV }, { path: ATT_RUN }],
    'runBackup 必须收到归一化后的 {path}[]');
});

test('EFW-2 未配置 extraFiles 时传空数组（不是 undefined）', async () => {
  const a = await captureBackupArgs(makeConfig());
  assert.deepEqual(a.extraFiles, [], '未配置必须是空数组：runBackup 里的默认值是 []，undefined 会让它跳过而不是显式为空');
});

test('EFW-3 非法 extraFiles 在进入远端操作之前就被拒绝', async () => {
  let runCalled = false;
  const svc = createService({
    config: makeConfig({ extraFiles: [{ path: 'relative/x' }] }),
    deps: deps({
      runBackup: async () => { runCalled = true; return { ok: true }; },
    }),
  });
  await assert.rejects(() => svc.backup('toogel'), /加密单文件配置非法/);
  assert.equal(runCalled, false, '配置非法时不该已经跑到远端去');
});

test('EFW-4 重复的 extraFiles 也会被拒绝（不是「反正是同一个文件」就放行）', async () => {
  const svc = createService({
    config: makeConfig({ extraFiles: [{ path: ATT_ENV }, { path: ATT_ENV }] }),
    deps: deps({}),
  });
  await assert.rejects(() => svc.backup('toogel'), /加密单文件配置非法.*重复/);
});

// ---------------- EFW-B：backup.js 内部 ----------------

test('EFW-5 runBackup 在写 MANIFEST 之前完成单文件收集（晚一步包就不在包里）', async () => {
  const src = await readFile(`${ROOT}lib/backup.js`, 'utf8');
  const packIdx = src.indexOf('await packExtraFiles(');
  assert.ok(packIdx > 0, 'backup.js 必须调用 packExtraFiles');

  const manifestIdx = src.indexOf('extraFiles: extraFilesRecord,');
  assert.ok(manifestIdx > packIdx,
    'extraFiles 写进 manifestMeta 必须发生在打包之后，否则 MANIFEST 声称有它、外层 tar 里却没有');
});

test('EFW-6 只记元数据：backup.js 不把文件内容写进 MANIFEST', async () => {
  const src = await readFile(`${ROOT}lib/backup.js`, 'utf8');
  const seg = src.slice(src.indexOf('let extraFilesRecord'), src.indexOf('extraFiles: extraFilesRecord,'));
  assert.equal(/readFile\(\s*[a-zA-Z.]*env/i.test(seg), false, '不得读取文件内容');
  assert.match(seg, /files:\s*extraFilesResult\.files/, '只记录远端回执里的逐文件元数据');
});

test('EFW-7 extra-files-runner 在解析失败时抛错，不返回半个结果', async () => {
  const { packExtraFiles } = await import('../lib/extra-files-runner.js');
  // 远端没跑完（缺 EFILE_RC）→ 必须抛
  await assert.rejects(
    () => packExtraFiles({
      server: { name: 'x' },
      workDir: '/tmp/w',
      ts: '20261124-1',
      files: [{ path: ATT_ENV }],
      exec: async () => ({ stdout: 'EFILE\t/opt/a\t1\t600\t0\t0\t' + 'a'.repeat(64), stderr: '' }),
    }),
    /单文件收集失败/,
  );
});

test('EFW-8 缺文件时错误信息里点名是哪个文件（不能只说「收集失败」）', async () => {
  const { packExtraFiles } = await import('../lib/extra-files-runner.js');
  await assert.rejects(
    () => packExtraFiles({
      server: { name: 'x' },
      workDir: '/tmp/w',
      ts: '20261124-1',
      files: [{ path: ATT_ENV }],
      exec: async () => ({
        stdout: [`EFILE_MISSING\t${ATT_ENV}\t不存在`, 'EFILE_RC=96'].join('\n'),
        stderr: '',
      }),
    }),
    (e) => {
      assert.match(e.message, /不静默跳过/);
      assert.ok(e.message.includes(ATT_ENV), '错误里必须点名缺了哪个文件');
      return true;
    },
  );
});

test('EFW-9 空列表直接返回，不发任何远端命令', async () => {
  const { packExtraFiles } = await import('../lib/extra-files-runner.js');
  let called = 0;
  const r = await packExtraFiles({
    server: { name: 'x' },
    workDir: '/tmp/w',
    ts: 't',
    files: [],
    exec: async () => { called += 1; return { stdout: '', stderr: '' }; },
  });
  assert.equal(called, 0, '没配单文件时不该产生任何远端调用');
  assert.equal(r.file, null);
  assert.deepEqual(r.files, []);
});
