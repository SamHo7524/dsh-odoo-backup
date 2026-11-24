/**
 * v0.3.1 — 依赖快照从配置到备份包的接线验证。
 *
 * 与 `deps-lock.test.js` 的分工：那个证明纯函数对；这个证明
 * **「谁把什么交给了谁」**——字段存住了、算对了，但没人把它传给 runBackup，
 * 是这个仓库踩过两次的坑（v0.2.2 入口未 import、v0.2.6 打包漏子目录）。
 * M26 那次变异存活也是同一个教训：「配置存住了」≠「配置真的用上了」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { createService } from '../lib/service.js';
import { packDepsLocks } from '../lib/deps-lock-runner.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

const WEB_VENV = '/opt/web_cs/venv';
const SHA = 'b'.repeat(64);

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

// ---------------- DLW：服务层传递 ----------------

test('DLW-1 服务器上的 depsLocks 以 {name,venvPath}[] 交给 runBackup', async () => {
  const a = await captureBackupArgs(makeConfig({
    depsLocks: [{ name: 'web-cs', venvPath: WEB_VENV }],
  }));
  assert.deepEqual(a.depsLocks, [{ name: 'web-cs', venvPath: WEB_VENV }],
    'runBackup 必须收到归一化后的 {name,venvPath}[]');
});

test('DLW-2 未配置时传空数组（不是 undefined）', async () => {
  const a = await captureBackupArgs(makeConfig());
  assert.deepEqual(a.depsLocks, [],
    '未配置必须是空数组：runBackup 默认值是 []，undefined 会让它跳过而不是显式为空');
});

test('DLW-3 字符串简写在服务层就被派生成 {name,venvPath}', async () => {
  const a = await captureBackupArgs(makeConfig({ depsLocks: [WEB_VENV] }));
  assert.deepEqual(a.depsLocks, [{ name: 'web-cs', venvPath: WEB_VENV }]);
});

test('DLW-4 非法 depsLocks 在触达远端之前被拒绝', async () => {
  let runCalled = false;
  const svc = createService({
    config: makeConfig({ depsLocks: [{ name: 'Bad Name', venvPath: WEB_VENV }] }),
    deps: deps({ runBackup: async () => { runCalled = true; return { ok: true }; } }),
  });
  await assert.rejects(() => svc.backup('toogel'), /依赖快照配置非法/);
  assert.equal(runCalled, false, '配置非法时不该已经跑到远端去（前面几百 MB 的 dump 会白做）');
});

test('DLW-5 runBackup 在写 MANIFEST 之前生成锁文件（晚一步锁文件就不在包里）', async () => {
  const src = await readFile(`${ROOT}lib/backup.js`, 'utf8');
  const packIdx = src.indexOf('await packDepsLocks(');
  assert.ok(packIdx > 0, 'backup.js 必须调用 packDepsLocks');
  const manifestIdx = src.indexOf('depsLocks: depsLocksRecords,');
  assert.ok(manifestIdx > packIdx,
    'depsLocks 写进 manifestMeta 必须发生在生成之后，否则 MANIFEST 声称有它、包内却没有');
});

test('DLW-6 runBackup 的 return 体带上 depsLocks 回执（否则调用方看不到生成了什么）', async () => {
  const src = await readFile(`${ROOT}lib/backup.js`, 'utf8');
  const retIdx = src.lastIndexOf('depsLocks: depsLocksRecords,');
  const manifestIdx = src.indexOf('depsLocks: depsLocksRecords,');
  assert.ok(retIdx > manifestIdx, 'return 体里必须也有一处 depsLocks');
});

test('DLW-7 depsLocks 回执用函数作用域变量（续传路径不会 ReferenceError）', async () => {
  const src = await readFile(`${ROOT}lib/backup.js`, 'utf8');
  assert.match(src, /let depsLocksRecords = \[\];/, '必须在块外声明，否则续传路径拿到的是块内 const');
  const declIdx = src.indexOf('let depsLocksRecords');
  const useIdx = src.indexOf('depsLocksRecords = depsResult.locks;');
  assert.ok(useIdx > declIdx, '赋值必须发生在声明之后');
});

// ---------------- DLR：执行层 ----------------

const GOOD_STDOUT = [
  `DLOCK\tweb-cs\t/tmp/w/web-cs-requirements.lock\t4096\t${SHA}\t3.12.3\t65`,
  'DLOCK_RC=0',
  'DLOCK_COUNT=1',
].join('\n');

test('DLR-1 正常路径：回执只含元数据，且 file 为 null（锁文件靠外层 tar 带走）', async () => {
  const r = await packDepsLocks({
    server: { name: 'x' },
    workDir: '/tmp/w',
    locks: [{ name: 'web-cs', venvPath: WEB_VENV }],
    exec: async () => ({ stdout: GOOD_STDOUT, stderr: '' }),
  });
  assert.equal(r.ok, true);
  assert.equal(r.file, null, '锁文件不是独立 tar 产物，由外层 tar 一并带走');
  assert.deepEqual(r.locks, [{
    name: 'web-cs',
    file: 'web-cs-requirements.lock',
    bytes: 4096,
    sha256: SHA,
    pythonVersion: '3.12.3',
    packages: 65,
  }]);
});

test('DLR-2 空列表直接返回，不发任何远端命令', async () => {
  let called = 0;
  const r = await packDepsLocks({
    server: { name: 'x' },
    workDir: '/tmp/w',
    locks: [],
    exec: async () => { called += 1; return { stdout: '', stderr: '' }; },
  });
  assert.equal(called, 0, '没配依赖快照时不该产生任何远端调用');
  assert.deepEqual(r.locks, []);
  assert.equal(r.file, null);
});

test('DLR-3 缺 venv 时抛错并点名是哪条（不静默跳过）', async () => {
  await assert.rejects(
    () => packDepsLocks({
      server: { name: 'x' },
      workDir: '/tmp/w',
      locks: [{ name: 'web-cs', venvPath: WEB_VENV }],
      exec: async () => ({
        stdout: [`DLOCK_MISSING\tweb-cs\t${WEB_VENV}\t虚拟环境目录不存在`, 'DLOCK_RC=96'].join('\n'),
        stderr: '',
      }),
    }),
    (e) => {
      assert.match(e.message, /不静默跳过/);
      assert.ok(e.message.includes('web-cs'), '错误里必须点名是哪条快照');
      assert.ok(e.message.includes(WEB_VENV), '还要带上路径，否则不知道去查哪台机器的哪个目录');
      return true;
    },
  );
});

test('DLR-4 0 个包时抛错（空快照不算依赖依据）', async () => {
  await assert.rejects(
    () => packDepsLocks({
      server: { name: 'x' },
      workDir: '/tmp/w',
      locks: [{ name: 'web-cs', venvPath: WEB_VENV }],
      exec: async () => ({
        stdout: [`DLOCK\tweb-cs\t/tmp/w/x.lock\t100\t${SHA}\t3.12.3\t0`, 'DLOCK_RC=0', 'DLOCK_COUNT=1'].join('\n'),
        stderr: '',
      }),
    }),
    /0 个包|空快照/,
  );
});

test('DLR-5 远端没跑完（缺 DLOCK_RC）时抛错，不返回半个结果', async () => {
  await assert.rejects(
    () => packDepsLocks({
      server: { name: 'x' },
      workDir: '/tmp/w',
      locks: [{ name: 'web-cs', venvPath: WEB_VENV }],
      exec: async () => ({ stdout: `DLOCK\tweb-cs\t/tmp/w/x.lock\t100\t${SHA}\t3.12.3\t5`, stderr: '' }),
    }),
    /依赖快照收集失败/,
  );
});

test('DLR-6 传给远端的 stdin 里，路径含空格不会错位（用 tab 分隔）', async () => {
  let seenStdin = '';
  await packDepsLocks({
    server: { name: 'x' },
    workDir: '/tmp/w',
    locks: [{ name: 'obsidian', venvPath: '/root/Documents/Obsidian Vault/venv' }],
    exec: async (_s, _script, opts) => {
      seenStdin = opts.stdin;
      return {
        stdout: [
          `DLOCK\tobsidian\t/tmp/w/obsidian-requirements.lock\t10\t${SHA}\t3.12.3\t1`,
          'DLOCK_RC=0',
          'DLOCK_COUNT=1',
        ].join('\n'),
        stderr: '',
      };
    },
  });
  assert.ok(seenStdin.includes('obsidian\t/root/Documents/Obsidian Vault/venv'),
    'name 与路径之间必须是 tab，否则含空格的路径会被切成两段');
});
