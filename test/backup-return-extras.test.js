/**
 * v0.2.4 RED — runBackup 必须**跑到函数末尾的 return**，并把 extras 回执带出来。
 *
 * 为什么需要这个测试（血的教训）：
 *   v0.2.3 里 `extrasResult` 声明在 `if (!resumePlan) { ... }` 块内，
 *   而 `extras: extrasResult.extras` 写在函数末尾的 return 里。
 *   语法合法、静态断言全绿、单元测试全绿——因为**没有任何测试真正执行到那一行**。
 *   真机上 600 MB 下载了 20 分钟、加密之前才炸 `ReferenceError`，
 *   一次备份白跑，且失败的包已被清理。静态源码断言（TBX-5）挡不住作用域错误。
 *
 * 本测试用注入的远端执行器 + 下载器跑完整链路（新建任务、小文件路径），
 * 断言返回值里 extras 是真实打包记录，而不是块内变量。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { runBackup } from '../lib/backup.js';

/**
 * 构造一个让 runBackup 走完「建目录→dump→打包→extras→MANIFEST→外层 tar→下载→加密→清理→return」
 * 的假环境。所有远端命令按脚本指纹分发，返回值只需含各段标记。
 */
function makeFakeExec({ extrasBytes = 1024, withExtraFiles = false } = {}) {
  const calls = [];
  const exec = async (server, script, opts = {}) => {
    calls.push({ script, stdin: opts.stdin ?? '' });
    const s = String(script);

    // 1) 建工作目录
    if (s.includes('mkdir -p "$D"') && s.includes('echo OK')) {
      return { code: 0, stdout: 'OK\n', stderr: '' };
    }
    // 2) dump 脚本
    if (s.includes('===DUMP_START===')) {
      return {
        code: 0,
        stdout: [
          '===DUMP_START===',
          'x'.repeat(64),
          '===SIZE===',
          '2048',
          '===SHA===',
          'a'.repeat(64),
          '===RC===',
          '0',
          '===END===',
        ].join('\n'),
        stderr: '',
      };
    }
    // 3) pack 脚本（addons/pydeps/conf）
    // 标记顺序必须与 lib/backup.js buildPackScript 的真实输出一致：
    // COMPRESSOR → PACK_ADDONS → PACK_PYDEPS → CONF → EXT → END
    // 顺序写错会让 section() 取到跨段的脏值（曾导致 compressor='zstd\n===EXT===\nzst'）。
    if (s.includes('===PACK_ADDONS===')) {
      return {
        code: 0,
        stdout: [
          '===COMPRESSOR===',
          'zstd',
          '===PACK_ADDONS===',
          'addons_ok',
          '===PACK_PYDEPS===',
          'pydeps_ok',
          '===CONF===',
          'conf_ok',
          '===EXT===',
          'zst',
          '===END===',
        ].join('\n'),
        stderr: '',
      };
    }
    // 4) extras 预检脚本
    if (s.includes('PROBE_RC=')) {
      return {
        code: 0,
        stdout: [
          'PROBE\t1\t/root/Documents/Obsidian Vault\t' + extrasBytes,
          'AVAIL\t' + 100 * 1024 ** 3,
          'PROBE_RC=0',
        ].join('\n'),
        stderr: '',
      };
    }
    // 5) extras 打包脚本
    if (s.includes('EXTRA_RC=')) {
      return {
        code: 0,
        stdout: [
          'EXTRA_RC=0',
          'EXTRA_ZRC=0',
          `EXTRA_BYTES=${extrasBytes}`,
          'EXTRA_SHA256=' + 'b'.repeat(64),
          'EXTRA_ERR=',
        ].join('\n'),
        stderr: '',
      };
    }
    // 5b) 加密单文件打包脚本（v0.2.9）
    if (s.includes('EFILE_RC=')) {
      if (!withExtraFiles) {
        // 没配单文件却被打到，说明调用链多走了一步 —— 直接让测试炸出来。
        return { code: 0, stdout: 'EFILE_RC=0\nEFILE_COUNT=0\nEFILE_BYTES=0\nEFILE_SHA256=\n', stderr: '' };
      }
      const p = '/opt/1panel/runtime/python/attendance/.env';
      return {
        code: 0,
        stdout: [
          `EFILE\t${p}\t197\t600\t0\t0\t${'d'.repeat(64)}`,
          'EFILE_RC=0',
          'EFILE_COUNT=1',
          'EFILE_BYTES=1024',
          'EFILE_SHA256=' + 'e'.repeat(64),
          'EFILE_ERR=',
        ].join('\n'),
        stderr: '',
      };
    }
    // 6) 写 MANIFEST
    if (s.includes('base64 -d > "$D/MANIFEST.json"')) {
      return { code: 0, stdout: 'OK\n', stderr: '' };
    }
    // 7) 外层 tar
    if (s.includes('tar -cf "$O"')) {
      return {
        code: 0,
        stdout: ['4096', 'c'.repeat(64), '===END==='].join('\n'),
        stderr: '',
      };
    }
    // 8) 清理远端
    if (s.includes('rm -rf "$W"')) {
      return { code: 0, stdout: 'OK\n', stderr: '' };
    }
    return { code: 0, stdout: 'OK\n', stderr: '' };
  };
  return { exec, calls };
}

async function makeLocalDir() {
  return mkdtemp(join(tmpdir(), 'ob-ret-'));
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

test('RET-1 runBackup 走完整链路后 return 出 extras（块内变量漏出作用域的直接回归）', async () => {
  const localDir = await makeLocalDir();
  try {
    const { exec } = makeFakeExec({ extrasBytes: 24982343 });

    const res = await runBackup({
      server,
      instance,
      localDir,
      passphrase: 'pw',
      extraPaths: [{ name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'], maxBytes: null }],
      _execRemote: exec,
      // 小文件路径：注入 scpDownload，把「远端 tar」写成真实文件
      deps: {
        scpDownload: async (_server, _remote, localPath) => {
          await writeFile(localPath, Buffer.alloc(4096, 7));
        },
        statfs: async () => ({ bsize: 4096, bavail: 10 ** 9 }),
      },
    });

    assert.equal(res.ok, true);
    assert.ok(Array.isArray(res.extras), 'extras 必须是数组（缺了就是作用域 bug）');
    assert.equal(res.extras.length, 1);
    assert.equal(res.extras[0].name, 'vault');
    assert.equal(res.extras[0].bytes, 24982343);
    assert.equal(res.extras[0].sha256, 'b'.repeat(64));
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});

test('RET-2 续传路径没有本次打包结果时 extras 为空数组而非 ReferenceError', async () => {
  const localDir = await makeLocalDir();
  try {
    const { exec } = makeFakeExec();
    const res = await runBackup({
      server,
      instance,
      localDir,
      passphrase: 'pw',
      extraPaths: [], // 未配置额外路径
      _execRemote: exec,
      deps: {
        scpDownload: async (_server, _remote, localPath) => {
          await writeFile(localPath, Buffer.alloc(4096, 7));
        },
        statfs: async () => ({ bsize: 4096, bavail: 10 ** 9 }),
      },
    });
    assert.equal(res.ok, true);
    assert.deepEqual(res.extras, [], '无额外路径时应为空数组');
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});

// ---------------- v0.2.9：加密单文件 ----------------
//
// RET-3/RET-4 是变异验证逼出来的：把 `extraFilesResult.file ? {...} : null` 的三元
// 改成恒真（即「没打包也声称有」）时，全仓库没有一条测试变红 —— 因为此前没有任何
// 测试**执行到 runBackup 的 return** 去看 extraFiles 到底是什么。

test('RET-3 未配置加密单文件时 extraFiles 为 null（不能声称有）', async () => {
  const localDir = await makeLocalDir();
  try {
    const { exec } = makeFakeExec();
    const res = await runBackup({
      server,
      instance,
      localDir,
      passphrase: 'pw',
      extraPaths: [],
      extraFiles: [],
      _execRemote: exec,
      deps: {
        scpDownload: async (_server, _remote, localPath) => {
          await writeFile(localPath, Buffer.alloc(4096, 7));
        },
        statfs: async () => ({ bsize: 4096, bavail: 10 ** 9 }),
      },
    });
    assert.equal(res.ok, true);
    assert.equal(res.extraFiles, null,
      '没收集任何单文件时必须返回 null：返回一个空壳记录等于对外声称「包里有一份单文件包」，而实际没有');
    assert.equal(res.manifest.extraFiles, null, 'MANIFEST 里同样不能有记录');
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});

test('RET-4 配置了加密单文件时 extraFiles 带逐文件元数据，且不含任何内容字段', async () => {
  const localDir = await makeLocalDir();
  try {
    const { exec } = makeFakeExec({ withExtraFiles: true });
    const res = await runBackup({
      server,
      instance,
      localDir,
      passphrase: 'pw',
      extraPaths: [],
      extraFiles: [{ path: '/opt/1panel/runtime/python/attendance/.env' }],
      _execRemote: exec,
      deps: {
        scpDownload: async (_server, _remote, localPath) => {
          await writeFile(localPath, Buffer.alloc(4096, 7));
        },
        statfs: async () => ({ bsize: 4096, bavail: 10 ** 9 }),
      },
    });
    assert.equal(res.ok, true);
    assert.ok(res.extraFiles, '配置了单文件就必须带回执');
    assert.equal(res.extraFiles.present, true);
    // 时间戳是运行时生成的，只能断言形态，不能断言具体值。
    assert.match(res.extraFiles.file, /^extra-files-\d{8}-\d{6}\.tar\.gz$/);
    assert.equal(res.extraFiles.files.length, 1);
    assert.equal(res.extraFiles.files[0].path, '/opt/1panel/runtime/python/attendance/.env');
    assert.equal(res.extraFiles.files[0].mode, '600');
    // 元数据白名单：多出任何内容类字段都算泄密。
    assert.deepEqual(Object.keys(res.extraFiles.files[0]).sort(),
      ['bytes', 'gid', 'mode', 'path', 'sha256', 'uid']);
    assert.deepEqual(Object.keys(res.manifest.extraFiles).sort(),
      ['bytes', 'file', 'files', 'present', 'sha256']);
  } finally {
    await rm(localDir, { recursive: true, force: true });
  }
});
