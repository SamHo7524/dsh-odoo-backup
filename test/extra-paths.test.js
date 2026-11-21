import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_EXTRAS,
  validateExtraName,
  validateExtraPath,
  normalizeExtras,
  buildExtraPackStdin,
  parseExtraPackResult,
  buildExtraProbeScript,
  parseExtraProbe,
  planExtrasSpace,
  buildExtraPackScript,
} from '../lib/extra-paths.js';

test('EP-N1 合法名称通过', () => {
  for (const name of ['vault', 'hermes', 'obsidian-vault', 'a', 'A_1']) {
    const r = validateExtraName(name);
    assert.equal(r.ok, true, `${name} 应通过：${r.reason}`);
    assert.equal(r.name, name);
  }
});

test('EP-N2 目录穿越与非法字符被拒', () => {
  for (const name of ['../../etc/passwd', 'vault/x', 'a b', 'vault.md', '', ' ', '-vault', '.vault']) {
    const r = validateExtraName(name);
    assert.equal(r.ok, false, `${JSON.stringify(name)} 应被拒`);
    assert.equal(typeof r.reason, 'string');
    assert.ok(r.reason.length > 0);
  }
});

test('EP-N3 超过 32 字符被拒', () => {
  assert.equal(validateExtraName('a'.repeat(32)).ok, true);
  assert.equal(validateExtraName('a'.repeat(33)).ok, false);
});

test('EP-N4 与内置备份项重名被拒（大小写归一）', () => {
  for (const name of ['addons', 'pydeps', 'conf', 'dump', 'manifest', 'odoo', 'ADDONS', 'Manifest']) {
    const r = validateExtraName(name);
    assert.equal(r.ok, false, `${name} 与内置项重名应被拒`);
    assert.match(r.reason, /重名/);
  }
});

test('EP-N5 非字符串名称被拒', () => {
  for (const v of [null, undefined, 42, {}, []]) {
    assert.equal(validateExtraName(v).ok, false);
  }
});

test('EP-P1 含空格的绝对路径通过（真实目标路径）', () => {
  const p = '/root/Documents/Obsidian Vault';
  const r = validateExtraPath(p);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.path, p);
  assert.equal(validateExtraPath('/root/.hermes').ok, true);
});

test('EP-P2 非绝对路径被拒', () => {
  for (const p of ['root/x', './x', '', ' ', 'C:/x']) {
    assert.equal(validateExtraPath(p).ok, false, `${JSON.stringify(p)} 应被拒`);
  }
});

test('EP-P3 根目录与 .. 段被拒', () => {
  assert.equal(validateExtraPath('/').ok, false);
  assert.equal(validateExtraPath('/root/../etc').ok, false);
  assert.equal(validateExtraPath('/root/./x/../../etc').ok, false);
});

test('EP-P4 换行与空字节被拒（否则 stdin 协议错位）', () => {
  assert.equal(validateExtraPath('/root/a\nb').ok, false);
  assert.equal(validateExtraPath('/root/a\rb').ok, false);
  assert.equal(validateExtraPath('/root/a\0b').ok, false);
});

test('EP-P5 超长路径被拒', () => {
  assert.equal(validateExtraPath('/' + 'a'.repeat(510)).ok, true);
  assert.equal(validateExtraPath('/' + 'a'.repeat(512)).ok, false);
});

test('EP-X1 未配置时返回空数组而不是报错', () => {
  for (const v of [undefined, null, []]) {
    const r = normalizeExtras(v);
    assert.equal(r.ok, true, JSON.stringify(v));
    assert.deepEqual(r.extras, []);
  }
});

test('EP-X2 非数组被拒', () => {
  for (const v of ['vault', 42, {}]) {
    const r = normalizeExtras(v);
    assert.equal(r.ok, false);
    assert.match(r.reason, /数组/);
  }
});

test('EP-X3 正常条目归一化（缺省 exclude 变空数组）', () => {
  const r = normalizeExtras([
    { name: 'vault', path: '/root/Documents/Obsidian Vault' },
    { name: 'hermes', path: '/root/.hermes', exclude: ['./cache', '*.lock'], maxBytes: 1073741824 },
  ]);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.extras.length, 2);
  assert.deepEqual(r.extras[0].exclude, []);
  assert.equal(r.extras[0].maxBytes, null);
  assert.deepEqual(r.extras[1].exclude, ['./cache', '*.lock']);
  assert.equal(r.extras[1].maxBytes, 1073741824);
});

test('EP-X4 条目内非法名称/路径被拒且报出序号', () => {
  const r = normalizeExtras([
    { name: 'ok', path: '/root/ok' },
    { name: 'addons', path: '/root/x' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /第 2 条/);

  const r2 = normalizeExtras([{ name: 'ok', path: 'relative/x' }]);
  assert.equal(r2.ok, false);
  assert.match(r2.reason, /第 1 条/);
});

test('EP-X5 同名被拒（大小写归一）', () => {
  const r = normalizeExtras([
    { name: 'vault', path: '/root/a' },
    { name: 'VAULT', path: '/root/b' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /重名/);
});

test('EP-X6 超过上限被拒', () => {
  const many = Array.from({ length: MAX_EXTRAS + 1 }, (_, i) => ({ name: `x${i}`, path: `/root/x${i}` }));
  const r = normalizeExtras(many);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(String(MAX_EXTRAS)));

  assert.equal(normalizeExtras(many.slice(0, MAX_EXTRAS)).ok, true);
});

test('EP-X7 exclude 必须是字符串数组且不含换行', () => {
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', exclude: './cache' }]).ok, false);
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', exclude: ['./a\nb'] }]).ok, false);
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', exclude: [''] }]).ok, false);
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', exclude: ['./a', './b'] }]).ok, true);
});

test('EP-X8 maxBytes 必须是正整数或省略', () => {
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', maxBytes: 0 }]).ok, false);
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', maxBytes: -1 }]).ok, false);
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', maxBytes: 1.5 }]).ok, false);
  assert.equal(normalizeExtras([{ name: 'v', path: '/root/v', maxBytes: '100' }]).ok, false);
});

test('EP-X9 条目必须至少是对象', () => {
  assert.equal(normalizeExtras(['vault']).ok, false);
  assert.equal(normalizeExtras([null]).ok, false);
});
// ───────────────────────────── 协议层 ─────────────────────────────

test('EP-S1 buildExtraPackStdin 按约定顺序输出参数', () => {
  const stdin = buildExtraPackStdin({
    path: '/root/Documents/Obsidian Vault',
    outFile: '/tmp/odoo-backup-1/vault-1.tar.zst',
    compressor: 'zstd',
    exclude: ['./.git', '*.lock'],
  });
  assert.equal(stdin, '/root/Documents/Obsidian Vault\n/tmp/odoo-backup-1/vault-1.tar.zst\nzstd\n2\n./.git\n*.lock\n');
});

test('EP-S2 无排除时条数为 0 且不留多余空行', () => {
  const stdin = buildExtraPackStdin({ path: '/root/.hermes', outFile: '/tmp/o/h.tar.zst', compressor: 'gzip' });
  assert.equal(stdin, '/root/.hermes\n/tmp/o/h.tar.zst\ngzip\n0\n');
});

test('EP-S3 非法参数直接抛错（不生成会错位的 stdin）', () => {
  assert.throws(() => buildExtraPackStdin({ path: 'rel/x', outFile: '/tmp/o/a.tar.zst', compressor: 'zstd' }), /绝对路径/);
  assert.throws(() => buildExtraPackStdin({ path: '/root/a\nb', outFile: '/tmp/o/a.tar.zst', compressor: 'zstd' }), /换行/);
  assert.throws(() => buildExtraPackStdin({ path: '/root/a', outFile: '', compressor: 'zstd' }), /outFile/);
  assert.throws(() => buildExtraPackStdin({ path: '/root/a', outFile: '/tmp/o\na', compressor: 'zstd' }), /outFile/);
  assert.throws(() => buildExtraPackStdin({ path: '/root/a', outFile: '/tmp/o/a', compressor: 'xz' }), /压缩器/);
  assert.throws(() => buildExtraPackStdin({ path: '/root/a', outFile: '/tmp/o/a', compressor: 'zstd', exclude: ['./x\n'] }), /排除/);
});

test('EP-R1 正常结果解析出字节与 sha256', () => {
  const out = [
    'EXTRA_RC=0',
    'EXTRA_ZRC=0',
    'EXTRA_BYTES=947',
    'EXTRA_SHA256=b51ca02805dbad8500000000000000000000000000000000000000000000000a',
    'EXTRA_ERR=',
  ].join('\n');
  const r = parseExtraPackResult(out);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.rc, 0);
  assert.equal(r.bytes, 947);
  assert.match(r.sha256, /^[0-9a-f]{64}$/);
  assert.equal(r.warning, '');
});

test('EP-R2 tar 返回 1（读到活动文件）算成功但要带警告', () => {
  const out = 'EXTRA_RC=1\nEXTRA_ZRC=0\nEXTRA_BYTES=1024\nEXTRA_SHA256=' + 'a'.repeat(64) + '\nEXTRA_ERR=tar: /root/.hermes/state.db: file changed as we read it';
  const r = parseExtraPackResult(out);
  assert.equal(r.ok, true);
  assert.match(r.warning, /changed as we read it/);
});

test('EP-R3 tar 返回 >=2 必须失败并带摘要与退出码', () => {
  const r = parseExtraPackResult('EXTRA_RC=2\nEXTRA_ZRC=0\nEXTRA_BYTES=0\nEXTRA_SHA256=\nEXTRA_ERR=tar: /root/x: Cannot open: Permission denied');
  assert.equal(r.ok, false);
  assert.match(r.reason, /2/);
  assert.match(r.reason, /Permission denied/);
});

test('EP-R4 远端特殊退出码映射成可操作原因', () => {
  assert.match(parseExtraPackResult('EXTRA_RC=95').reason, /bash/);
  assert.match(parseExtraPackResult('EXTRA_RC=96').reason, /不可读/);
  assert.match(parseExtraPackResult('EXTRA_RC=97').reason, /不存在/);
  assert.match(parseExtraPackResult('EXTRA_RC=98').reason, /排除/);
});

test('EP-R5 没拿到 EXTRA_RC 视为失败（不许默认成功）', () => {
  const r = parseExtraPackResult('');
  assert.equal(r.ok, false);
  assert.match(r.reason, /没有输出/);
});

test('EP-R6 sha256 缺失或非法视为失败（防空包）', () => {
  assert.equal(parseExtraPackResult('EXTRA_RC=0\nEXTRA_ZRC=0\nEXTRA_BYTES=10\nEXTRA_SHA256=').ok, false);
  assert.equal(parseExtraPackResult('EXTRA_RC=0\nEXTRA_ZRC=0\nEXTRA_BYTES=10\nEXTRA_SHA256=nothex').ok, false);
});

test('EP-R7 字节为 0 或非法视为失败', () => {
  assert.equal(parseExtraPackResult('EXTRA_RC=0\nEXTRA_ZRC=0\nEXTRA_BYTES=0\nEXTRA_SHA256=' + 'a'.repeat(64)).ok, false);
  assert.equal(parseExtraPackResult('EXTRA_RC=0\nEXTRA_ZRC=0\nEXTRA_BYTES=x\nEXTRA_SHA256=' + 'a'.repeat(64)).ok, false);
});

test('EP-R8 压缩器失败必须失败（否则留下半个包）', () => {
  const r = parseExtraPackResult('EXTRA_RC=0\nEXTRA_ZRC=2\nEXTRA_BYTES=10\nEXTRA_SHA256=' + 'a'.repeat(64));
  assert.equal(r.ok, false);
  assert.match(r.reason, /压缩/);
});

test('EP-PB1 预检输出解析出条目与可用空间', () => {
  const out = [
    'PROBE\t1\t/root/Documents/Obsidian Vault\t116500892',
    'PROBE\t0\t/root/.hermes\t0',
    'AVAIL\t24691154944',
    'PROBE_RC=0',
  ].join('\n');
  const r = parseExtraProbe(out);
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[0], { path: '/root/Documents/Obsidian Vault', exists: true, bytes: 116500892 });
  assert.deepEqual(r.entries[1], { path: '/root/.hermes', exists: false, bytes: 0 });
  assert.equal(r.availableBytes, 24691154944);
});

test('EP-PB2 远端无 bash 的预检失败', () => {
  const r = parseExtraProbe('PROBE_RC=95');
  assert.equal(r.ok, false);
  assert.match(r.reason, /bash/);
});

test('EP-PB3 拿不到 df 可用空间时为 null（不等于 0）', () => {
  const r = parseExtraProbe('PROBE\t1\t/root/a\t5\nPROBE_RC=0');
  assert.equal(r.ok, true);
  assert.equal(r.availableBytes, null);
});

test('EP-SP1 空间充足放行', () => {
  const r = planExtrasSpace({
    dumpBytes: 600 * 1024 * 1024,
    extraBytes: 100 * 1024 * 1024,
    availableBytes: 23 * 1024 * 1024 * 1024,
  });
  assert.equal(r.ok, true, r.message);
  assert.ok(r.requiredBytes > 0);
});

test('EP-SP2 空间不足必须报出所需与可用两个具体数字', () => {
  const r = planExtrasSpace({
    dumpBytes: 600 * 1024 * 1024,
    extraBytes: 5 * 1024 * 1024 * 1024,
    availableBytes: 1 * 1024 * 1024 * 1024,
  });
  assert.equal(r.ok, false);
  assert.match(r.message, /9\.2 GB|9\.2GB|9395|9\.17/);
  assert.match(r.message, /1\.0 GB|1\.0GB|1024/);
});

test('EP-SP3 无法确认可用空间时拒绝（fail-closed）', () => {
  const r = planExtrasSpace({ dumpBytes: 1, extraBytes: 1, availableBytes: null });
  assert.equal(r.ok, false);
  assert.match(r.message, /无法确认/);
});

test('EP-SP4 需求 = 额外×1.5 + dump×2 + 余量', () => {
  const margin = 512 * 1024 * 1024;
  const r = planExtrasSpace({
    dumpBytes: 1000,
    extraBytes: 2000,
    availableBytes: 1,
    marginBytes: margin,
  });
  assert.equal(r.requiredBytes, 2000 * 1.5 + 1000 * 2 + margin);
});

test('EP-SC1 打包脚本契约：无 | head、取 PIPESTATUS 数组、引号完整', () => {
  const s = buildExtraPackScript();
  assert.match(s, /BASH_VERSION/);
  assert.ok(s.includes('st=("${PIPESTATUS[@]}")'), '必须一次性取 PIPESTATUS 数组');
  assert.ok(!s.includes('| head'), '禁止 | head（pipefail 下 SIGPIPE 会提前退出）');
  assert.match(s, /--numeric-owner/);
  assert.ok(s.includes('-C "$SRC"'), '必须用引号包裹含空格的源目录');
  assert.ok(s.includes('-- .'), '必须固定为 -- . 而非通配展开');
  assert.match(s, /EXTRA_RC=/);
  assert.match(s, /EXTRA_SHA256=/);
  assert.match(s, /zstd -3/);
  assert.match(s, /gzip -6/);
  assert.equal(buildExtraPackScript(), s, '脚本必须确定（同参数同输出）');
});

test('EP-SC2 预检脚本契约：只读、含 du/df、无 | head', () => {
  const s = buildExtraProbeScript();
  assert.match(s, /du -sb/);
  assert.match(s, /df -B1/);
  assert.match(s, /PROBE/);
  assert.ok(!s.includes('| head'));
  assert.ok(!/rm -rf|> *\/root|mkfs/.test(s), '预检脚本不得有写操作');
});