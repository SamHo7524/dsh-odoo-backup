/**
 * v0.3.1 — runBackup 真正执行到 return，验证依赖快照回执。
 *
 * 为什么必须再写一个（M67 逼出来的）：
 *   `deps-lock-wiring.test.js` 里 DLW-5/6/7 都是**静态源码断言**——
 *   只要 `await packDepsLocks(` 这几个字还在源码里，它们就全绿。
 *   把调用改成 `await Promise.resolve({locks:[]}); void packDepsLocks; if (false) await packDepsLocks({`
 *   之后，字面量照旧存在、静态断言照旧通过，而**锁文件根本没生成**，M67 存活。
 *
 *   这与 v0.2.4 的 RET-1（extrasResult 漏出作用域）、v0.2.9 的 RET-3（extraFiles 三元恒真）
 *   是同一个盲区：**没人执行到那一行，静态断言就证明不了它跑过**。
 *
 * 本测试用假远端执行器跑完整 runBackup 链路，断言：
 *   1. res.depsLocks 是真实解出的回执（name/file/bytes/sha256/pythonVersion/packages）；
 *   2. res.manifest.depsLocks 与之一致（MANIFEST 声称有 = 包里真有）；
 *   3. 远端确实收到了依赖快照脚本（调用记录里有），而不是被跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBackup } from '../lib/backup.js';

const LOCK_SHA = 'f'.repeat(64);

/**
 * 在 makeFakeExec 的基础上加两段：
 *  - deps lock 脚本（`DLOCK_RC=`）；
 *  - 其余段与 backup-return-extras.test.js 保持一致。
 */
function makeFakeExec({ withDepsLocks = false, packages = 65 } = {}) {
  const calls = [];
  const exec = async (server, script, opts = {}) => {
    calls.push({ script: String(script), stdin: opts.stdin ?? '' });
    const s = String(script);

    if (s.includes('mkdir -p "$D"') && s.includes('echo OK')) {
      return { code: 0, stdout: 'OK\n', stderr: '' };
    }
    if (s.includes('===DUMP_START===')) {
      return {
        code: 0,
        stdout: [
          '===DUMP_START===', 'x'.repeat(64), '===SIZE===', '2048',
          '===SHA===', 'a'.repeat(64), '===RC===', '0', '===END===',
        ].join('\n'),
        stderr: '',
      };
    }
    // 顺序必须与 buildPackScript 真实输出一致（写错会让 section() 取到跨段脏值）。
    if (s.includes('===PACK_ADDONS===')) {
      return {
        code: 0,
        stdout: [
          '===COMPRESSOR===', 'zstd',
          '===PACK_ADDONS===', 'addons_ok',
          '===PACK_PYDEPS===', 'pydeps_ok',
          '===CONF===', 'conf_ok',
          '===EXT===', 'zst',
          '===END===',
        ].join('\n'),
        stderr: '',
      };
    }
    if (s.includes('PROBE_RC=')) {
      return { code: 0, stdout: ['PROBE\t0', 'AVAIL\t107374182400', 'PROBE_RC=0'].join('\n'), stderr: '' };
    }
    // deps lock 脚本：只有真被调用才会走到这里。
    if (s.includes('DLOCK_RC=')) {
      if (!withDepsLocks) {
        // 没配快照却被打到 = 调用链多走了一步，让测试炸出来。
        return { code: 0, stdout: 'DLOCK_RC=94\nDLOCK_ERR=测试断言：不该调用\n', stderr: '' };
      }
      return {
        code: 0,
        stdout: [
          `DLOCK\tweb-cs\t/tmp/w/web-cs-requirements.lock\t4096\t${LOCK_SHA}\t3.12.3\t${packages}`,
          'DLOCK_RC=0',
          'DLOCK_COUNT=1',
        ].join('\n'),
        stderr: '',
      };
    }
    if (s.includes('base64 -d > "$D/MANIFEST.json"')) {
      return { code: 0, stdout: 'OK\n', stderr: '' };
    }
    if (s.includes('tar -cf "$O"')) {
      return { code: 0, stdout: ['4096', 'c'.repeat(64), '===END==='].join('\n'), stderr: '' };
    }
    if (s.includes('rm -rf "$W"')) {
      return { code: 0, stdout: 'OK\n', stderr: '' };
    }
    return { code: 0, stdout: 'OK\n', stderr: '' };
  };
  return { exec, calls };
}

const instance = {
  odooContainer: 'odoo-test',
  dbName: 'tg-odoo',
  dbHost: 'postgresql',
  dbPort: 5432,
  addonsPath: '/addons',
  dataPath: '/data',
  odooVersion: '19.0-test',
};

const server = { name: 'toogel', host: '1.2.3.4', port: 22, user: 'root' };

const deps = {
  scpDownload: async (_server, _remote, localPath) => {
    await writeFile(localPath, Buffer.alloc(4096, 7));
  },
  statfs: async () => ({ bsize: 4096, bavail: 10 ** 9 }),
};

test('DLI-1 runBackup 跑到 return 时 depsLocks 是真实回执（不是空壳）', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'ob-dli-'));
  try {
    const { exec, calls } = makeFakeExec({ withDepsLocks: true, packages: 65 });
    const res = await runBackup({
      server,
      instance,
      localDir,
      passphrase: 'pw',
      extraPaths: [],
      extraFiles: [],
      depsLocks: [{ name: 'web-cs', venvPath: '/opt/web_cs/venv' }],
      _execRemote: exec,
      deps,
    });

    assert.equal(res.ok, true);

    // ① 远端真的收到了依赖快照脚本（杀掉「调用被跳过」这类变异）。
    const lockCall = calls.find((c) => c.script.includes('DLOCK_RC='));
    assert.ok(lockCall, 'runBackup 必须真的调用 packDepsLocks 到远端，而不仅仅在源码里提到它');

    // ② 回执是解出来的真实内容。
    assert.ok(Array.isArray(res.depsLocks), 'depsLocks 必须是数组（缺了就是作用域 bug）');
    assert.equal(res.depsLocks.length, 1);
    assert.deepEqual(res.depsLocks[0], {
      name: 'web-cs',
      file: 'web-cs-requirements.lock',
      bytes: 4096,
      sha256: LOCK_SHA,
      pythonVersion: '3.12.3',
      packages: 65,
    });

    // ③ MANIFEST 与回执一致：声称有 = 包里真有。
    assert.deepEqual(res.manifest.depsLocks, res.depsLocks);
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});

test('DLI-2 未配置依赖快照时 depsLocks 为空数组且不发远端命令', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'ob-dli-'));
  try {
    const { exec, calls } = makeFakeExec({ withDepsLocks: false });
    const res = await runBackup({
      server,
      instance,
      localDir,
      passphrase: 'pw',
      extraPaths: [],
      extraFiles: [],
      depsLocks: [],
      _execRemote: exec,
      deps,
    });

    assert.equal(res.ok, true);
    assert.deepEqual(res.depsLocks, [], '未配置必须是空数组，不能是 null（否则分不清「没配」和「配了但失败」）');
    assert.deepEqual(res.manifest.depsLocks, []);
    const lockCall = calls.find((c) => c.script.includes('DLOCK_RC='));
    assert.equal(lockCall, undefined, '没配快照时不该产生任何远端调用');
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});

test('DLI-3 快照生成失败时整次备份失败（不产出「看起来成功但装不起来」的包）', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'ob-dli-'));
  try {
    const { exec } = makeFakeExec({ withDepsLocks: true, packages: 0 });
    await assert.rejects(
      () => runBackup({
        server,
        instance,
        localDir,
        passphrase: 'pw',
        extraPaths: [],
        extraFiles: [],
        depsLocks: [{ name: 'web-cs', venvPath: '/opt/web_cs/venv' }],
        _execRemote: exec,
        deps,
      }),
      /0 个包|空快照/,
    );
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});
