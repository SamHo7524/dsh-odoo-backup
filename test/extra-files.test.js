import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_EXTRA_FILES,
  normalizeExtraFiles,
  validateExtraFile,
  fileLabel,
  buildExtraFilesPackStdin,
  buildExtraFilesPackScript,
  parseExtraFilesPackResult,
} from '../lib/extra-files.js';

// ---------------- EF-V：校验 ----------------

test('EF-V1 合法绝对路径通过', () => {
  for (const p of [
    '/opt/1panel/runtime/python/attendance/.env',
    '/opt/1panel/runtime/python/attendance/run.sh',
    '/root/.hermes/.env',
  ]) {
    const r = validateExtraFile(p);
    assert.equal(r.ok, true, `${p} 应通过`);
    assert.equal(r.path, p);
  }
});

test('EF-V2 相对路径 / 根 / 尾部斜杠 / .. 全部拒绝', () => {
  assert.match(validateExtraFile('opt/x/.env').reason, /绝对路径/);
  assert.match(validateExtraFile('/').reason, /根目录/);
  assert.match(validateExtraFile('/opt/x/').reason, /以 \/ 结尾/);
  assert.match(validateExtraFile('/opt/../etc/passwd').reason, /\.\./);
});

test('EF-V3 含换行 / 制表符 / 空字节的路径拒绝（防 stdin 协议断裂）', () => {
  assert.match(validateExtraFile('/opt/a\nb').reason, /换行/);
  assert.match(validateExtraFile('/opt/a\tb').reason, /制表符|换行/);
  assert.match(validateExtraFile('/opt/a\0b').reason, /空字节|换行/);
});

// ---------------- EF-N：归一化 ----------------

test('EF-N1 未配置 → 空列表且 ok', () => {
  assert.deepEqual(normalizeExtraFiles(undefined), { ok: true, files: [] });
  assert.deepEqual(normalizeExtraFiles(null), { ok: true, files: [] });
});

test('EF-N2 字符串与 {path} 两种写法都接受', () => {
  const r = normalizeExtraFiles(['/opt/a/.env', { path: '/opt/a/run.sh' }]);
  assert.equal(r.ok, true);
  assert.deepEqual(r.files, [{ path: '/opt/a/.env' }, { path: '/opt/a/run.sh' }]);
});

test('EF-N3 重复路径拒绝（否则 MANIFEST 会出现两条一样记录）', () => {
  const r = normalizeExtraFiles(['/opt/a/.env', '/opt/a/.env']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /重复/);
});

test('EF-N4 超上限拒绝，并在理由里说清上限', () => {
  const many = Array.from({ length: MAX_EXTRA_FILES + 1 }, (_, i) => `/opt/f${i}`);
  const r = normalizeExtraFiles(many);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`最多 ${MAX_EXTRA_FILES} 条`));
});

test('EF-N5 非法项整体拒绝，不做「一部分生效」', () => {
  const r = normalizeExtraFiles(['/opt/a/.env', 'relative/x']);
  assert.equal(r.ok, false);
  assert.match(r.reason, /第 2 条/);
});

// ---------------- EF-S：stdin 协议 ----------------

test('EF-S1 stdin 顺序固定：outFile / 条数 / 各路径', () => {
  const s = buildExtraFilesPackStdin({
    files: [{ path: '/opt/a/.env' }, { path: '/opt/b/run.sh' }],
    outFile: '/tmp/w/efiles-x.tar.gz',
  });
  assert.equal(s, '/tmp/w/efiles-x.tar.gz\n2\n/opt/a/.env\n/opt/b/run.sh\n');
});

test('EF-S2 空列表 / 空 outFile 抛错（宁可炸在上游，不要发一个空参数块）', () => {
  assert.throws(() => buildExtraFilesPackStdin({ files: [], outFile: '/tmp/x' }), /不能为空/);
  assert.throws(() => buildExtraFilesPackStdin({ files: ['/opt/a'], outFile: '' }), /不能为空/);
});

test('EF-S3 outFile 含换行抛错（换行会错位整个 stdin 协议）', () => {
  assert.throws(() => buildExtraFilesPackStdin({ files: ['/opt/a'], outFile: '/tmp/a\nb' }), /换行/);
});

// ---------------- EF-P：脚本契约 ----------------

test('EF-P1 脚本必须声明不用 set -e 且不用 head', () => {
  const script = buildExtraFilesPackScript();
  assert.match(script, /不使用 set -e/);
  // 逐行判「真的 set -e 指令」而不是子串：注释里写着「不使用 set -e」也含这个子串，
  // 直接 includes 会把说明文字当成违规（本条测试首轮就这么红了一次）。
  const bare = script
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  assert.equal(bare.some((l) => /^set -e\b/.test(l)), false, 'set -e 会让中间某条失败就静默跳过后续校验');
  assert.equal(bare.some((l) => /\bset\s+-[a-z]*e/.test(l)), false, '任何含 e 的 set 选项都等于 set -e');
  assert.match(script, /set -uo pipefail/);
  assert.equal(/\|\s*head\b/.test(script), false, 'pipefail 下 head 会触发 SIGPIPE 提前退出');
});

test('EF-P2 脚本必须逐条校验存在/普通文件/可读，且不满足时整体失败', () => {
  const script = buildExtraFilesPackScript();
  assert.match(script, /\[ ! -e "\$p" \]/);
  assert.match(script, /\[ ! -f "\$p" \]/);
  assert.match(script, /\[ ! -r "\$p" \]/);
  assert.match(script, /EFILE_RC=96/);
  // 只要有 BAD 就 exit，不能把好文件先打了包
  assert.match(script, /if \[ "\$BAD" -ne 0 \]; then/);
});

test('EF-P3 打成员用 tar -C / 且去掉前导斜杠（恢复时 tar -C / 原位还原）', () => {
  const script = buildExtraFilesPackScript();
  assert.match(script, /tar -C \/ --numeric-owner -czf/);
  assert.match(script, /MEMBERS\+=\("\$\{p#\/\}"\)/);
});

test('EF-P4 只输出元数据，不输出文件内容', () => {
  const script = buildExtraFilesPackScript();
  assert.match(script, /EFILE\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s/);
  // 元数据六项：路径 字节 模式 uid gid sha
  assert.equal(/cat "\$p"/.test(script), false, '脚本绝不能 cat 文件内容');
  assert.equal(/base64 "\$p"/.test(script), false, '脚本绝不对文件内容做 base64');
});

test('EF-P5 脚本是只读的：没有 rm/mv 动源文件', () => {
  const script = buildExtraFilesPackScript();
  const sourceTouching = /(rm|mv|chmod|chown)\s+[^\n]*"\$p"/.test(script);
  assert.equal(sourceTouching, false, '收集过程绝不能修改源文件');
});

// ---------------- EF-R：结果解析 ----------------

const HAPPY = [
  'EFILE\t/opt/a/.env\t197\t600\t0\t0\tabcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  'EFILE\t/opt/b/run.sh\t50\t644\t0\t0\t1111111111111111111111111111111111111111111111111111111111111111',
  'EFILE_RC=0',
  'EFILE_COUNT=2',
  'EFILE_BYTES=4096',
  'EFILE_SHA256=2222222222222222222222222222222222222222222222222222222222222222',
  'EFILE_ERR=',
].join('\n');

test('EF-R1 正常结果：解析出条目元数据与包信息', () => {
  const r = parseExtraFilesPackResult(HAPPY);
  assert.equal(r.ok, true);
  assert.equal(r.bytes, 4096);
  assert.equal(r.sha256, '2'.repeat(64));
  assert.equal(r.entries.length, 2);
  assert.deepEqual(r.entries[0], {
    path: '/opt/a/.env',
    bytes: 197,
    mode: '600',
    uid: 0,
    gid: 0,
    sha256: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  });
  assert.deepEqual(r.missing, []);
});

test('EF-R2 缺 EFILE_RC → ok:false（没拿到确定结果不算成功）', () => {
  const r = parseExtraFilesPackResult('EFILE\t/opt/a/.env\t1\t600\t0\t0\t' + 'a'.repeat(64));
  assert.equal(r.ok, false);
  assert.match(r.reason, /EFILE_RC/);
});

test('EF-R3 rc=96 缺文件 → ok:false，且理由里逐个报出缺了谁', () => {
  const out = [
    'EFILE_MISSING\t/opt/a/.env\t不存在',
    'EFILE_MISSING\t/opt/b/run.sh\t不可读',
    'EFILE_RC=96',
    'EFILE_ERR=存在缺失或不可读的单文件',
  ].join('\n');
  const r = parseExtraFilesPackResult(out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /不静默跳过/);
  assert.match(r.reason, /\/opt\/a\/\.env（不存在）/);
  assert.match(r.reason, /\/opt\/b\/run\.sh（不可读）/);
  assert.equal(r.missing.length, 2);
});

test('EF-R4 条目数与远端自报不符 → ok:false（说明有文件没进包）', () => {
  const out = HAPPY.replace('EFILE_COUNT=2', 'EFILE_COUNT=3');
  const r = parseExtraFilesPackResult(out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /条目数不一致：远端自报 3 条，实际解析到 2 条/);
});

test('EF-R5 空包 / 缺 sha256 → ok:false', () => {
  const zero = HAPPY.replace('EFILE_BYTES=4096', 'EFILE_BYTES=0');
  assert.match(parseExtraFilesPackResult(zero).reason, /疑似空包/);

  const noSha = HAPPY.replace('EFILE_SHA256=' + '2'.repeat(64), 'EFILE_SHA256=');
  assert.match(parseExtraFilesPackResult(noSha).reason, /缺少合法 sha256/);
});

test('EF-R6 tar 失败（rc>=2）→ ok:false 并带上 tar 的输出', () => {
  const out = ['EFILE_RC=2', 'EFILE_ERR=tar: /opt/a/.env: Cannot open: Permission denied'].join('\n');
  const r = parseExtraFilesPackResult(out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /tar 退出码 2/);
  assert.match(r.reason, /Permission denied/);
});

test('EF-R7 rc=95 缺 bash → 明确的失败理由', () => {
  const r = parseExtraFilesPackResult('EFILE_RC=95\nEFILE_ERR=远端没有 bash');
  assert.equal(r.ok, false);
  assert.match(r.reason, /缺少 bash/);
});

// ---------------- EF-L：标签 ----------------

test('EF-L1 fileLabel 取 basename，无斜杠时原样返回', () => {
  assert.equal(fileLabel('/opt/a/.env'), '.env');
  assert.equal(fileLabel('/opt/a/run.sh'), 'run.sh');
  assert.equal(fileLabel('run.sh'), 'run.sh');
  assert.equal(fileLabel(''), '');
});
