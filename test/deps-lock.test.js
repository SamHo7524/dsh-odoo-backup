/**
 * v0.3.1 — 依赖快照（deps lock）的纯函数层测试。
 *
 * 由来（真机恢复演练，2026-11-24）：`/opt/web_cs` 在生产上有 65 个已安装 Python 包，
 * 但目录里**没有任何依赖声明文件**（requirements.txt / pyproject.toml / setup.py / Pipfile
 * 全部不存在）。恢复源码与配置之后，`webchat.service` 报
 * `Command /opt/web_cs/venv/bin/python3 is not executable`，服务起不来。
 *
 * 核心判断：**「文件都在」≠「服务能跑」**。依赖必须有明确的版本依据，
 * 而 `pip freeze` 是唯一能从运行中的 venv 反推出这份依据的办法。
 *
 * 与 extraFiles 的区别（**不要合并**）：
 *  - extraFiles 收的是**已经存在的文件**（.env / run.sh），路径存在即可打包；
 *  - depsLocks 收的是**现场生成的快照**（在 venv 上跑 pip freeze），产物在远端不存在。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_DEPS_LOCKS,
  validateDepsLock,
  normalizeDepsLocks,
  deriveLockName,
  buildDepsLockStdin,
  buildDepsLockScript,
  parseDepsLockResult,
  parseLockFile,
  compareFreezeToLock,
  buildDepsRestoreScript,
  lockFileName,
  LOCK_FILE_HEADER,
} from '../lib/deps-lock.js';

// ---------------- DL-V：单条校验 ----------------

test('DL-V1 合法的 {name, venvPath} 通过', () => {
  const r = validateDepsLock({ name: 'web-cs', venvPath: '/opt/web_cs/venv' });
  assert.equal(r.ok, true);
  assert.equal(r.lock.name, 'web-cs');
  assert.equal(r.lock.venvPath, '/opt/web_cs/venv');
});

test('DL-V2 venvPath 相对路径 / 根 / 尾部斜杠 / .. 全部拒绝', () => {
  assert.match(validateDepsLock({ name: 'a', venvPath: 'opt/venv' }).reason, /绝对路径/);
  assert.match(validateDepsLock({ name: 'a', venvPath: '/' }).reason, /根目录/);
  assert.match(validateDepsLock({ name: 'a', venvPath: '/opt/venv/' }).reason, /以 \/ 结尾/);
  assert.match(validateDepsLock({ name: 'a', venvPath: '/opt/../etc' }).reason, /\.\./);
});

test('DL-V3 name 必须是 slug（产物文件名直接用它，含斜杠会写出目录外）', () => {
  for (const bad of ['', '  ', 'Web-CS', 'web cs', 'web/cs', '../x', '-lead']) {
    const r = validateDepsLock({ name: bad, venvPath: '/opt/web_cs/venv' });
    assert.equal(r.ok, false, `${JSON.stringify(bad)} 应被拒`);
  }
  assert.equal(validateDepsLock({ name: 'web-cs2', venvPath: '/opt/v' }).ok, true);
});

test('DL-V4 含换行 / 制表符 / 空字节的路径拒绝（防 stdin 协议断裂）', () => {
  assert.match(validateDepsLock({ name: 'a', venvPath: '/opt/a\nb' }).reason, /换行/);
  assert.match(validateDepsLock({ name: 'a', venvPath: '/opt/a\tb' }).reason, /制表符|换行/);
  assert.match(validateDepsLock({ name: 'a', venvPath: '/opt/a\0b' }).reason, /空字节|换行/);
});

test('DL-V5 缺 name 或 venvPath 时明确说缺哪个（派生是归一化层的事，单条校验不猜）', () => {
  assert.match(validateDepsLock({ venvPath: '/opt/v' }).reason, /name/);
  assert.match(validateDepsLock({ name: 'a' }).reason, /venvPath/);
});

// ---------------- DL-N：归一化 ----------------

test('DL-N1 未配置 → 空列表且 ok', () => {
  assert.deepEqual(normalizeDepsLocks(undefined), { ok: true, locks: [] });
  assert.deepEqual(normalizeDepsLocks(null), { ok: true, locks: [] });
});

test('DL-N2 字符串写法 = 只给 venvPath，name 从父目录派生', () => {
  const r = normalizeDepsLocks(['/opt/web_cs/venv']);
  assert.equal(r.ok, true);
  assert.equal(r.locks[0].name, 'web-cs', '/opt/web_cs/venv 应派生出 web-cs（父目录、下划线转连字符）');
  assert.equal(r.locks[0].venvPath, '/opt/web_cs/venv');
});

test('DL-N3 派生名：下划线转连字符、转小写、去掉尾部 !-! 等非法字符', () => {
  assert.equal(deriveLockName('/opt/web_cs/venv'), 'web-cs');
  assert.equal(deriveLockName('/srv/My_App/.venv'), 'my-app');
  assert.equal(deriveLockName('/only'), 'only', '路径只有一段时就用该段本身');
  assert.equal(deriveLockName('/opt/only'), 'only', '非 venv 类目录名直接取末段');
  assert.equal(deriveLockName('/opt/web_cs/venv'), 'web-cs', 'venv 这类通用名往上取一级');
});

test('DL-N4 重复 name 拒绝（产物文件会互相覆盖）', () => {
  const r = normalizeDepsLocks([
    { name: 'web-cs', venvPath: '/opt/a/venv' },
    { name: 'web-cs', venvPath: '/opt/b/venv' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /重复/);
});

test('DL-N5 重复 venvPath 拒绝（同一份快照记两次只会让人以为备了两个东西）', () => {
  const r = normalizeDepsLocks([
    { name: 'a', venvPath: '/opt/x/venv' },
    { name: 'b', venvPath: '/opt/x/venv' },
  ]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /重复/);
});

test('DL-N6 超上限拒绝，并在理由里说清上限', () => {
  const many = Array.from({ length: MAX_DEPS_LOCKS + 1 }, (_, i) => ({ name: `a${i}`, venvPath: `/opt/v${i}` }));
  const r = normalizeDepsLocks(many);
  assert.equal(r.ok, false);
  assert.match(r.reason, new RegExp(`最多 ${MAX_DEPS_LOCKS} 条`));
});

test('DL-N7 非法项整体拒绝，不做「一部分生效」', () => {
  const r = normalizeDepsLocks([{ name: 'ok', venvPath: '/opt/v' }, { name: 'BAD NAME', venvPath: '/opt/w' }]);
  assert.equal(r.ok, false);
  assert.match(r.reason, /第 2 条/);
});

// ---------------- DL-S：远端脚本协议 ----------------

test('DL-S1 脚本不用 set -e、不接 head（pipefail 下 SIGPIPE 会提前退出）', () => {
  const code = buildDepsLockScript();
  const exec = code
    .split('\n')
    .filter((l) => !l.trim().startsWith('#'))
    .join('\n');
  assert.equal(/^\s*set -e/m.test(exec), false, '不得使用 set -e');
  assert.equal(/\|\s*head\b/.test(exec), false, '不得把输出接给 head');
  assert.match(exec, /set -uo pipefail/, '必须显式设置 pipefail 以便捕获管道失败');
});

test('DL-S2 stdin 协议：<输出目录> <条数 N> 后跟 N 行 name\\tvenvPath', () => {
  const stdin = buildDepsLockStdin({
    outDir: '/tmp/w',
    locks: [{ name: 'web-cs', venvPath: '/opt/web_cs/venv' }],
  });
  const lines = stdin.trimEnd().split('\n');
  assert.equal(lines[0], '/tmp/w');
  assert.equal(lines[1], '1');
  assert.equal(lines[2], 'web-cs\t/opt/web_cs/venv');
});

test('DL-S3 stdin 里出现换行注入时在 JS 侧就抛错（不依赖远端兜底）', () => {
  assert.throws(
    () => buildDepsLockStdin({ outDir: '/tmp/w', locks: [{ name: 'a', venvPath: '/opt/a\nb' }] }),
    /换行/,
  );
});

test('DL-S4 脚本必须记录 python 版本、pip 版本、生成时间与包数（缺一项就无法复核）', () => {
  const code = buildDepsLockScript();
  assert.match(code, /python.*-V|--version/, '必须取 Python 版本');
  assert.match(code, /pip.*--version|pip.*-V/i, '必须取 pip 版本');
  assert.match(code, /date -u?/, '必须记录生成时间（UTC，避免时区歧义）');
  assert.match(code, /wc -l/, '必须统计包数');
  assert.match(code, /sha256sum/, '必须算 sha256');
});

test('DL-S5 脚本 fail-closed：venv 不存在 / 无 bin/python / pip freeze 失败都拒绝（不生成空快照）', () => {
  const code = buildDepsLockScript();
  assert.match(code, /DLOCK_MISSING/, '缺 venv 必须单列一条缺失记录');
  // 「目录不存在」(96) 与「目录在但不是虚拟环境」(97) 必须分开：
  // 一个是路径漂移，一个是备错了目录，查错方向完全不同。
  assert.match(code, /\bRC=96\b/, '缺 venv 必须记为 96');
  assert.match(code, /\bRC=97\b/, '不是虚拟环境（无 bin/python 或 bin/pip）必须记为 97');
  assert.match(code, /DLOCK_RC=\$RC/, '退出码统一从 RC 输出（保证与 96/97 一致）');
  assert.match(code, /DLOCK_RC=98/, 'pip freeze 失败要走 98 硬退出，不留半套快照');
  // pip freeze 失败时必须清掉半成品，否则会留下一个 0 字节的「看起来像快照」的文件。
  assert.match(code, /rm -f [^\n]*\$LOCK\.body/, 'freeze 失败后必须删除半成品');
});

test('DL-S5b 缺 pip 也判为「不是虚拟环境」，不能当成 freeze 失败', () => {
  const code = buildDepsLockScript();
  assert.match(code, /\[ ! -x "\$VP\/bin\/pip" \]/, '必须单独检查 bin/pip');
  const seg = code.slice(code.indexOf('[ ! -x "$VP/bin/pip" ]'));
  assert.match(seg.slice(0, 300), /RC=97/, '缺 bin/pip 归到 97（同属「不是虚拟环境」）');
});

test('DL-S6 脚本不得把包列表直接打到 stdout（产物走文件，stdout 只出元数据）', () => {
  const code = buildDepsLockScript();
  const exec = code.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  // 意图是「锁文件内容不走 stdout」。`cat` 只允许出现在重定向进锁文件的那一段，
  // 不允许出现 `cat "$LOCK"` 这种把成品直接吐到标准输出的写法。
  assert.equal(/cat\s+"?\$LOCK"?\s*(?:\||$)/m.test(exec), false, '不得把锁文件内容 cat 到 stdout');
  assert.match(exec, /DLOCK\\t/, '每个锁文件只回一行元数据（不含包清单）');
  const metaLine = exec.split('\n').find((l) => l.includes('printf') && l.includes('DLOCK\\t'));
  assert.ok(metaLine, '必须有 metadata 输出行');
  // 元数据行报的是锁文件的**路径**与哈希，不是内容——所以允许出现 $LOCK 路径变量，
  // 但不允许出现把内容内联进 printf 参数的形态。
  assert.equal(/\$\(cat\s/.test(metaLine), false, '不得在元数据行里内联文件内容');
});

// ---------------- DL-P：结果解析 ----------------

const SHA = 'a'.repeat(64);

test('DL-P1 正常输出解析出 name / bytes / sha256 / python / 包数', () => {
  const stdout = [
    `DLOCK\tweb-cs\t/tmp/w/web-cs-requirements.lock\t4096\t${SHA}\t3.12.3\t65`,
    'DLOCK_RC=0',
    'DLOCK_COUNT=1',
  ].join('\n');
  const r = parseDepsLockResult(stdout);
  assert.equal(r.ok, true);
  assert.equal(r.entries.length, 1);
  assert.deepEqual(r.entries[0], {
    name: 'web-cs',
    file: 'web-cs-requirements.lock',
    bytes: 4096,
    sha256: SHA,
    pythonVersion: '3.12.3',
    packages: 65,
  });
});

test('DL-P2 没有 DLOCK_RC → 未拿到结果（可能被杀或被截断）', () => {
  const r = parseDepsLockResult(`DLOCK\tweb-cs\t/tmp/w/x.lock\t100\t${SHA}\t3.12.3\t10`);
  assert.equal(r.ok, false);
  assert.match(r.reason, /未拿到结果|DLOCK_RC/);
});

test('DL-P3 缺 venv → 失败并点名是哪条（不静默跳过）', () => {
  const stdout = [
    'DLOCK_MISSING\tweb-cs\t/opt/web_cs/venv\t虚拟环境目录不存在',
    'DLOCK_RC=96',
  ].join('\n');
  const r = parseDepsLockResult(stdout);
  assert.equal(r.ok, false);
  assert.match(r.reason, /不静默跳过/);
  assert.match(r.reason, /web-cs/);
  assert.match(r.reason, /不存在/);
});

test('DL-P4 不是虚拟环境（无 bin/python）→ 失败并说明原因', () => {
  const r = parseDepsLockResult([
    'DLOCK_MISSING\tweb-cs\t/opt/web_cs/venv\t目录存在但缺少 bin/python（不是虚拟环境）',
    'DLOCK_RC=97',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /bin\/python/);
});

test('DL-P5 pip freeze 失败 → 失败并带上远端错误输出', () => {
  const r = parseDepsLockResult([
    'DLOCK_RC=98',
    'DLOCK_ERR=pip freeze 退出码 1: No module named pip',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /pip freeze/);
});

test('DL-P6 产物字节数为 0 或负 → 疑似空快照，判失败', () => {
  const r = parseDepsLockResult([
    `DLOCK\tweb-cs\t/tmp/w/web-cs-requirements.lock\t0\t${SHA}\t3.12.3\t0`,
    'DLOCK_RC=0',
    'DLOCK_COUNT=1',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /空快照|字节数/);
});

test('DL-P7 包数为 0 → 失败（空 venv 不算依赖依据）', () => {
  const r = parseDepsLockResult([
    `DLOCK\tweb-cs\t/tmp/w/web-cs.lock\t100\t${SHA}\t3.12.3\t0`,
    'DLOCK_RC=0',
    'DLOCK_COUNT=1',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /0 个包|空/);
});

test('DL-P8 sha256 非法 → 失败', () => {
  const r = parseDepsLockResult([
    'DLOCK\tweb-cs\t/tmp/w/x.lock\t100\tNOTAHASH\t3.12.3\t5',
    'DLOCK_RC=0',
    'DLOCK_COUNT=1',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /sha256/);
});

test('DL-P9 自报条数与实际解析数不符 → 失败（有锁文件没生成出来）', () => {
  const r = parseDepsLockResult([
    `DLOCK\tweb-cs\t/tmp/w/web-cs.lock\t100\t${SHA}\t3.12.3\t5`,
    'DLOCK_RC=0',
    'DLOCK_COUNT=2',
  ].join('\n'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /不一致/);
});

test('DL-P10 远端缺 bash → 明确报 95，不误报成配置问题', () => {
  const r = parseDepsLockResult('DLOCK_RC=95\nDLOCK_ERR=远端没有 bash');
  assert.equal(r.ok, false);
  assert.match(r.reason, /bash/);
});

test('DL-P11 CRLF 输出与 LF 输出解析结果必须一致', () => {
  // 真机事故：同一份远端正向输出经中转链路变成 CRLF 后，parseDepsLockResult 报
  // 「没有输出 DLOCK_RC，未拿到结果」——DLOCK 元数据行解析出来了，标记行却匹配不到，
  // 于是「成功生成的锁文件」被判成「没拿到结果」。同文件的 parseLockFile 早就做了
  // CRLF 归一化，说明这是遗漏而非设计。
  const lf = [
    `DLOCK\tweb-cs\t/tmp/w/web-cs-requirements.lock\t4096\t${SHA}\t3.12.3\t65`,
    'DLOCK_RC=0',
    'DLOCK_COUNT=1',
  ].join('\n');
  const crlf = lf.replace(/\n/g, '\r\n');

  const a = parseDepsLockResult(lf);
  const b = parseDepsLockResult(crlf);

  assert.equal(a.ok, true, 'LF 输入应成功');
  assert.equal(b.ok, true, 'CRLF 输入也必须成功：行尾不是远端脚本的语义');
  assert.deepEqual(b.entries, a.entries, '条目必须完全一致');
  assert.equal(b.rc, 0);
});

test('DL-P12 CRLF 下的失败标记也必须被识别（不能把失败读成成功）', () => {
  const crlf = 'DLOCK_MISSING\tweb-cs\t/opt/web_cs/venv\t虚拟环境目录不存在\r\nDLOCK_RC=96\r\n';
  const r = parseDepsLockResult(crlf);
  assert.equal(r.ok, false, 'CRLF 下 rc=96 仍必须判失败');
  assert.match(r.reason, /虚拟环境|96/);
  assert.equal(r.missing.length, 1, 'missing 条目不能被行尾切断');
  assert.equal(r.missing[0].venvPath, '/opt/web_cs/venv', '路径结尾不能残留 \\r');
});

test('DL-P13 孤立 CR（无 LF）也必须按行切分', () => {
  // 某些串口/旧式工具与「只把 \n 换成 \r」的中转脚本会产出孤立 CR。
  // 只认 \r\n 的归一化会让整段输出变成**一行**，于是 DLOCK_RC 被吞进
  // 「路径」字段里 —— 表现同样是「成功的结果被判成没拿到结果」。
  const crOnly = [
    `DLOCK\tweb-cs\t/tmp/w/web-cs-requirements.lock\t4096\t${SHA}\t3.12.3\t65`,
    'DLOCK_RC=0',
    'DLOCK_COUNT=1',
  ].join('\r');
  const r = parseDepsLockResult(crOnly);
  assert.equal(r.ok, true, '孤立 CR 输入应被正确切行后解析成功');
  assert.equal(r.entries.length, 1);
  assert.equal(r.entries[0].packages, 65);
  assert.equal(r.entries[0].pythonVersion, '3.12.3', '字段里不能残留 \\r');
});

test('DL-P14 多条快照在 CRLF/孤立 CR 下行数不能塌陷', () => {
  // 单条时「吞行」不一定露馅：一条 DLOCK 行被 `\t` 切开后，前 6 个字段仍然正确，
  // 只有包数字段尾部沾上了下一行。多配一条就能把「塌陷成一行」直接量出来。
  const lines = [
    `DLOCK\tweb-cs\t/tmp/w/web-cs-requirements.lock\t4096\t${SHA}\t3.12.3\t65`,
    `DLOCK\tattendance\t/tmp/w/attendance-requirements.lock\t951\t${SHA}\t3.12.3\t34`,
    'DLOCK_RC=0',
    'DLOCK_COUNT=2',
  ];
  for (const [label, text] of [
    ['LF', lines.join('\n')],
    ['CRLF', lines.join('\r\n')],
    ['孤立CR', lines.join('\r')],
  ]) {
    const r = parseDepsLockResult(text);
    assert.equal(r.ok, true, `${label}: 应解析成功`);
    assert.equal(r.entries.length, 2, `${label}: 两条快照必须解析成两条，不能塌成一条`);
    assert.deepEqual(r.entries.map((e) => [e.name, e.packages]), [['web-cs', 65], ['attendance', 34]],
      `${label}: 名称与包数都要精确`);
  }
});

// ---------------- DL-F：锁文件格式（生成侧与复核侧必须可对账） ----------------

/** 真机 pip freeze 输出长这样：一行一个 `pkg==ver`，没有注释、没有空行。 */
const SAMPLE_LOCK = [
  '# dsh-odoo-backup deps lock v1',
  '# name: web-cs',
  '# venv: /opt/web_cs/venv',
  '# python: 3.12.3',
  '# pip: 24.0',
  '# generated: 2026-11-24T12:34:56Z',
  '# packages: 3',
  '# restore: python3 -m venv <target> && <target>/bin/pip install -r <this file>',
  'absl-py==2.1.0',
  'faiss-cpu==1.14.3',
  'numpy==2.5.1',
].join('\n') + '\n';

test('DL-F1 parseLockFile 读回请求头与包清单', () => {
  const r = parseLockFile(SAMPLE_LOCK);
  assert.equal(r.ok, true);
  assert.equal(r.name, 'web-cs');
  assert.equal(r.venvPath, '/opt/web_cs/venv');
  assert.equal(r.pythonVersion, '3.12.3');
  assert.equal(r.pipVersion, '24.0');
  assert.equal(r.generatedAt, '2026-11-24T12:34:56Z');
  assert.equal(r.declaredPackages, 3);
  assert.deepEqual(r.packages, ['absl-py==2.1.0', 'faiss-cpu==1.14.3', 'numpy==2.5.1']);
});

test('DL-F2 LOCK_FILE_HEADER 是锁文件首行（恢复侧靠它认出这是本插件生成的快照）', () => {
  assert.equal(LOCK_FILE_HEADER, '# dsh-odoo-backup deps lock v1');
  assert.ok(SAMPLE_LOCK.startsWith(LOCK_FILE_HEADER));
  assert.equal(parseLockFile('flask==3.0.3' + String.fromCharCode(10)).ok, false, '没有首行就不是锁文件');
});

test('DL-F3 自报包数与实际行数不符 → 判失败（快照被截断）', () => {
  const r = parseLockFile(SAMPLE_LOCK.replace('# packages: 3', '# packages: 5'));
  assert.equal(r.ok, false);
  assert.match(r.reason, /不一致|截断/);
});

test('DL-F4 拒绝没有头部的内容（可能是随便一个 requirements.txt）', () => {
  const r = parseLockFile('flask==3.0.3' + String.fromCharCode(10) + 'gunicorn==22.0.0' + String.fromCharCode(10));
  assert.equal(r.ok, false);
  assert.match(r.reason, /头部|认不出|不是/);
});

test('DL-F5 包清单为空 → 判失败（空快照没有恢复价值）', () => {
  const r = parseLockFile(SAMPLE_LOCK.replace('# packages: 3', '# packages: 0')
    .replace('absl-py==2.1.0' + String.fromCharCode(10), '')
    .replace('faiss-cpu==1.14.3' + String.fromCharCode(10), '')
    .replace('numpy==2.5.1' + String.fromCharCode(10), ''));
  assert.equal(r.ok, false);
  assert.match(r.reason, /空|0 个包/);
});

test('DL-F6 缺 python 版本行 → 判失败（没有版本就没法判断能否重建）', () => {
  const r = parseLockFile(SAMPLE_LOCK.replace('# python: 3.12.3' + String.fromCharCode(10), ''));
  assert.equal(r.ok, false);
  assert.match(r.reason, /python/i);
});

test('DL-F7 CRLF 换行的锁文件也能解析（Windows 侧编辑过不至于整份作废）', () => {
  const crlf = SAMPLE_LOCK.split(String.fromCharCode(10)).join(String.fromCharCode(13, 10));
  const r = parseLockFile(crlf);
  assert.equal(r.ok, true);
  assert.deepEqual(r.packages, ['absl-py==2.1.0', 'faiss-cpu==1.14.3', 'numpy==2.5.1']);
});

// ---------------- DL-C：装完后的复核（验收判据） ----------------

test('DL-C1 完全一致 → ok，多余/缺失都为空', () => {
  const r = compareFreezeToLock(['b==2', 'a==1'], ['a==1', 'b==2']);
  assert.equal(r.ok, true);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.extra, []);
});

test('DL-C2 少了包 → 不 ok 并逐个列出 missing（顺序无关）', () => {
  const r = compareFreezeToLock(['a==1'], ['a==1', 'b==2', 'c==3']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['b==2', 'c==3']);
  assert.deepEqual(r.extra, []);
});

test('DL-C3 多了包 → 也报告（不是「多装点没关系」，多装的会改变行为）', () => {
  const r = compareFreezeToLock(['a==1', 'zzz==9'], ['a==1']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.extra, ['zzz==9']);
});

test('DL-C4 版本号不同 → 报为缺失+多余，而不是笼统一句「不一致」', () => {
  const r = compareFreezeToLock(['numpy==2.5.1'], ['numpy==2.4.0']);
  assert.equal(r.ok, false);
  assert.deepEqual(r.missing, ['numpy==2.4.0']);
  assert.deepEqual(r.extra, ['numpy==2.5.1']);
});

test('DL-C5 忽略空行与注释行，且大小写/空白不敏感（pip 输出偶有尾随空格）', () => {
  const r = compareFreezeToLock(['  a==1  ', '', '# comment'], ['a==1']);
  assert.equal(r.ok, true);
});

// ---------------- DL-R：恢复侧脚本 ----------------

test('DL-R1 恢复脚本用临时 venv + pip install -r 装锁文件，装完回读 pip freeze 供对账', () => {
  const code = buildDepsRestoreScript();
  assert.match(code, /-m venv/, '必须新建 venv');
  assert.match(code, /pip"?\s+install\b[^\n]*\s-r\s|pip"?\s+install\b[^\n]*--requirement/, '必须按锁文件安装');
  assert.match(code, /"\$TARGET\/bin\/pip"\s+freeze/, '装完必须用**目标 venv** 的 pip 回读（不是系统 pip）');
  assert.match(code, /freeze/, '装完必须回读 pip freeze（DL-C 用它做验收）');
  assert.match(code, /set -uo pipefail/, '必须设置 pipefail');
});

test('DL-R2 恢复脚本不用 set -e、不接 head', () => {
  const code = buildDepsRestoreScript();
  const exec = code.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('#')).join(String.fromCharCode(10));
  assert.equal(/^\s*set -e/m.test(exec), false);
  assert.equal(/\|\s*head\b/.test(exec), false);
});

test('DL-R3 恢复脚本 fail-closed：ensurepip 不可用 / 安装失败 / 锁文件缺失都返回非 0 并说明', () => {
  const code = buildDepsRestoreScript();
  assert.match(code, /ensurepip|venv 创建失败/, '必须显式识别 ensurepip 缺失（真机踩过）');
  assert.match(code, /DREST_RC=9[0-9]/, '必须有明确错误码');
  assert.match(code, /python3\.12-venv/, '错误信息要指向预装包名');
});

// ---------------- DL-R4/R5：真机暴露的两个缺陷 ----------------
//
// 真机实测（2026-11-24，测试机 /tmp/dlock-restore/venv）：
//   DREST_RC=98
//   DREST_ERR=venv 创建失败（退出码 1）：          ← 冒号后面是空的
//   /tmp/_drestore.sh: line 41: /tmp/dlock-restore/venv.venv-err.98344: No such file or directory
//
// 两个独立缺陷叠在一起，而且第二个把第一个的**失败原因吞掉了**：
//   ① 目标父目录不存在时没先 mkdir -p，`python -m venv` 直接失败；
//   ② 错误捕获文件 `$TARGET.venv-err.$$` 落在**同一个不存在的目录**里，
//      重定向本身就失败 → VMSG 恒为空 → 报错信息只剩一个冒号。
// 这正是「日志把排查线索吃掉」的典型：脚本失败了，但失败理由被自己的日志机制弄丢了。

test('DL-R4 恢复脚本必须先创建目标父目录（否则 venv 建在不存在的一级目录下必失败）', () => {
  const code = buildDepsRestoreScript();
  const exec = code.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('#')).join(String.fromCharCode(10));
  const mk = exec.search(/mkdir -p\s+"?\$\(dirname\s+"\$TARGET"\)"?/);
  assert.ok(mk > 0, '必须 mkdir -p "$(dirname "$TARGET")"，不能假设父目录已经存在');
  const venv = exec.search(/-m venv/);
  assert.ok(venv > mk, 'mkdir 必须发生在 python -m venv 之前');
});

test('DL-R5 错误捕获文件不能落在目标目录里（目标不存在时重定向失败会吞掉真实原因）', () => {
  const code = buildDepsRestoreScript();
  const exec = code.split(String.fromCharCode(10)).filter((l) => !l.trim().startsWith('#')).join(String.fromCharCode(10));
  assert.equal(/\$TARGET\.(venv-err|pip-err)/.test(exec), false,
    '错误文件绝对不能写成 $TARGET.xxx：$TARGET 此刻还不存在，2>"$VERR" 会自己失败，VMSG 变空');
  assert.match(exec, /VERR=/, '仍要有错误捕获文件');
  assert.match(exec, /\/tmp|TMPDIR/, '错误捕获文件应落在 /tmp 或 $TMPDIR 这类一定存在的地方');
});
