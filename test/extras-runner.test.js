import test from 'node:test';
import assert from 'node:assert/strict';

import { packExtras } from '../lib/extras-runner.js';

const SERVER = { name: 'toogel', host: '47.121.205.143', user: 'root' };
const WORK = '/tmp/odoo-backup-1';
const TS = '20261120-1200';

const VAULT = { name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'], maxBytes: null };
const HERMES = { name: 'hermes', path: '/root/.hermes', exclude: ['./cache'], maxBytes: null };

const SHA = (c) => c.repeat(64);

/** 假 execRemote：按脚本特征分派，记录每次调用的 {kind, stdin}。 */
function fakeExec(handlers = {}) {
  const calls = [];
  const exec = async (server, script, opts = {}) => {
    const kind = script.includes('PROBE_RC')
      ? 'probe'
      : script.includes('EXTRA_RC')
        ? 'pack'
        : 'other';
    calls.push({ kind, script, stdin: opts.stdin ?? '' });
    const h = handlers[kind];
    if (!h) throw new Error(`未预期的远端调用：${kind}`);
    return h(opts.stdin ?? '', script, calls.filter((c) => c.kind === kind).length);
  };
  exec.calls = calls;
  return exec;
}

const probeOk = (bytes = { vault: 1000, hermes: 2000 }, avail = 50 * 1024 ** 3) => (stdin) => {
  const lines = stdin.split('\n');
  const n = Number(lines[0]);
  const paths = lines.slice(1, 1 + n);
  const rows = paths.map((p) => {
    const key = p.includes('Obsidian') ? 'vault' : 'hermes';
    return `PROBE\t1\t${p}\t${bytes[key] ?? 0}`;
  });
  return { code: 0, stdout: [...rows, `AVAIL\t${avail}`, 'PROBE_RC=0'].join('\n'), stderr: '' };
};

const packOk = (bytes = 111) => (stdin) => {
  const outFile = stdin.split('\n')[1];
  return {
    code: 0,
    stdout: [
      'EXTRA_RC=0',
      'EXTRA_ZRC=0',
      `EXTRA_BYTES=${bytes}`,
      `EXTRA_SHA256=${SHA('a')}`,
      'EXTRA_ERR=',
    ].join('\n'),
    stderr: '',
  };
};

const baseArgs = (over = {}) => ({
  server: SERVER,
  workDir: WORK,
  ts: TS,
  compressor: 'zstd',
  extras: [VAULT, HERMES],
  dumpBytes: 5 * 1024 ** 2,
  ...over,
});

test('EX-1 空列表不触达远端', async () => {
  const exec = fakeExec();
  const r = await packExtras(baseArgs({ extras: [], exec }));
  assert.deepEqual(r.extras, []);
  assert.equal(exec.calls.length, 0);
});

test('EX-2 先预检再打包，预检 stdin 是条数 + 各路径', async () => {
  const exec = fakeExec({ probe: probeOk(), pack: packOk() });
  await packExtras(baseArgs({ exec }));
  assert.equal(exec.calls[0].kind, 'probe');
  assert.equal(exec.calls[0].stdin, `2\n${VAULT.path}\n${HERMES.path}\n`);
  assert.equal(exec.calls.filter((c) => c.kind === 'pack').length, 2);
});

test('EX-3 额外路径不存在时整体失败，且不进入打包', async () => {
  const exec = fakeExec({
    probe: () => ({ code: 0, stdout: `PROBE\t1\t${VAULT.path}\t1000\nPROBE\t0\t${HERMES.path}\t0\nAVAIL\t99999999999\nPROBE_RC=0`, stderr: '' }),
    pack: packOk(),
  });
  await assert.rejects(() => packExtras(baseArgs({ exec })), (e) => {
    assert.match(e.message, /hermes/);
    assert.match(e.message, /不存在/);
    return true;
  });
  assert.equal(exec.calls.filter((c) => c.kind === 'pack').length, 0, '不应打包任何一条');
});

test('EX-4 空间不足时带数字失败，且不进入打包', async () => {
  const exec = fakeExec({ probe: probeOk({ vault: 4 * 1024 ** 3, hermes: 4 * 1024 ** 3 }, 1024 ** 3), pack: packOk() });
  await assert.rejects(() => packExtras(baseArgs({ exec })), (e) => {
    assert.match(e.message, /可用/);
    assert.match(e.message, /1\.0 GB/);
    return true;
  });
  assert.equal(exec.calls.filter((c) => c.kind === 'pack').length, 0);
});

test('EX-5 拿不到可用空间时 fail-closed', async () => {
  const exec = fakeExec({
    probe: (stdin) => ({
      code: 0,
      stdout: `PROBE\t1\t${VAULT.path}\t1000\nPROBE_RC=0`,
      stderr: '',
    }),
    pack: packOk(),
  });
  await assert.rejects(() => packExtras(baseArgs({ exec, extras: [VAULT] })), /无法确认/);
});

test('EX-6 每条产物带 file/bytes/sha256，文件名用 name-ts 且扩展名跟压缩器', async () => {
  const exec = fakeExec({ probe: probeOk(), pack: packOk(4242) });
  const r = await packExtras(baseArgs({ exec }));
  assert.equal(r.extras.length, 2);
  const [a, b] = r.extras;
  assert.equal(a.name, 'vault');
  assert.equal(a.file, `vault-${TS}.tar.zst`);
  assert.equal(a.path, VAULT.path);
  assert.equal(a.bytes, 4242);
  assert.equal(a.sha256, SHA('a'));
  assert.deepEqual(a.exclude, ['./.git']);
  assert.equal(b.file, `hermes-${TS}.tar.zst`);
  assert.equal(r.bytes, 8484);
});

test('EX-7 打包 stdin 含排除项与输出文件', async () => {
  const exec = fakeExec({ probe: probeOk(), pack: packOk() });
  await packExtras(baseArgs({ exec }));
  const packs = exec.calls.filter((c) => c.kind === 'pack');
  assert.equal(packs[0].stdin, `${VAULT.path}\n${WORK}/vault-${TS}.tar.zst\nzstd\n1\n./.git\n`);
  assert.equal(packs[1].stdin, `${HERMES.path}\n${WORK}/hermes-${TS}.tar.zst\nzstd\n1\n./cache\n`);
});

test('EX-8 gzip 压缩器时扩展名为 .gz', async () => {
  const exec = fakeExec({ probe: probeOk(), pack: packOk() });
  const r = await packExtras(baseArgs({ exec, compressor: 'gzip' }));
  assert.equal(r.extras[0].file, `vault-${TS}.tar.gz`);
});

test('EX-9 打包失败时要报出是哪一条，并保留原因', async () => {
  let n = 0;
  const exec = fakeExec({
    probe: probeOk(),
    pack: (stdin) => {
      n += 1;
      if (n === 1) return packOk()(stdin);
      return { code: 0, stdout: 'EXTRA_RC=2\nEXTRA_ZRC=0\nEXTRA_BYTES=0\nEXTRA_SHA256=\nEXTRA_ERR=tar: Permission denied', stderr: '' };
    },
  });
  await assert.rejects(() => packExtras(baseArgs({ exec })), (e) => {
    assert.match(e.message, /hermes/);
    assert.match(e.message, /Permission denied/);
    return true;
  });
});

test('EX-10 警告（tar 退出码 1）透传到结果，不吞掉', async () => {
  const exec = fakeExec({
    probe: probeOk(),
    pack: () => ({
      code: 0,
      stdout: `EXTRA_RC=1\nEXTRA_ZRC=0\nEXTRA_BYTES=10\nEXTRA_SHA256=${SHA('b')}\nEXTRA_ERR=file changed as we read it`,
      stderr: '',
    }),
  });
  const r = await packExtras(baseArgs({ exec, extras: [VAULT] }));
  assert.match(r.extras[0].warning, /changed as we read it/);
});

test('EX-11 进度上报包含 packing-extras 阶段与条目名', async () => {
  const seen = [];
  const exec = fakeExec({ probe: probeOk(), pack: packOk() });
  await packExtras(baseArgs({ exec, onProgress: (p) => seen.push(p) }));
  const phases = seen.map((s) => s.phase);
  assert.ok(phases.includes('packing-extras'));
  const msgs = seen.filter((s) => s.phase === 'packing-extras').map((s) => s.message).join(' ');
  assert.match(msgs, /vault/);
  assert.match(msgs, /hermes/);
});