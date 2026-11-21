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
function makeFakeExec({ extrasBytes = 1024 } = {}) {
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
