/**
 * v0.3.0 接线测试：`runRestore` 必须真的用上 conf 恢复。
 *
 * 为什么单独写一条：`restore-conf.test.js` 只证明「脚本和解析器正确」，
 * 证明不了「主流程调用了它们」。这正是上一轮 M26 的教训
 * ——配置存住了 ≠ 配置真的用上了，全仓库没有测试执行到 runRestore 的 return。
 *
 * `runRestore` 很难端到端跑（要 SSH、要真库），所以这里做**源码契约断言**：
 * 主流程必须 (a) 从 bundle 里取 conf、(b) 剔除脱敏行、(c) 上传、
 * (d) 调用 phaseRestoreConf、(e) 在 return 里带上结果。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SRC = new URL('../lib/restore.js', import.meta.url);

async function source() {
  return readFile(SRC, 'utf8');
}

test('CRA-1 extractBundle 必须把 conf 一起抽出来', async () => {
  const src = await source();
  const m = src.match(/export async function extractBundle[\s\S]*?\n\}/);
  assert.ok(m, '必须存在 extractBundle');
  assert.match(m[0], /conf:\s*pick\(\(n\)\s*=>\s*n === 'odoo\.conf'\)/,
    'extractBundle 不取 odoo.conf，MANIFEST 里即使有 conf 也回不到目标机');
});

test('CRA-2 上传前必须剔除脱敏的 admin_passwd 行', async () => {
  const src = await source();
  assert.match(src, /stripRedactedAdminPasswd\(raw\)/,
    '必须调用 stripRedactedAdminPasswd，否则会把 <REDACTED> 当口令拷回去');
  assert.match(src, /odoo\.conf\.restored/,
    '必须上传剔除后的副本，不能直接上传原文件');
});

test('CRA-3 主流程必须调用 phaseRestoreConf', async () => {
  const src = await source();
  assert.match(src, /const confRestore = await phaseRestoreConf\(/,
    'runRestore 必须实际执行 conf 恢复阶段');
  const iConf = src.search(/const confRestore = await phaseRestoreConf\(/);
  const iSafe = src.search(/const a = await phaseA_safetyBackup\(/);
  assert.ok(iConf > 0 && iSafe > 0 && iConf < iSafe,
    'conf 恢复必须发生在安全备份之前（配置先到位，切库后即生效）');
});

test('CRA-4 return 体必须带上 confRestore，否则调用方看不到结果', async () => {
  const src = await source();
  const iRet = src.search(/return \{\s*\n\s*ok: true,[\s\S]*?state,/);
  assert.ok(iRet > 0, '必须存在成功返回体');
  const tail = src.slice(iRet, iRet + 3000);
  assert.match(tail, /confRestore/, '成功返回体必须包含 confRestore');
});

test('CRA-5 phaseRestoreConf 必须在「没有 conf 文件」时明确说明跳过原因', async () => {
  const src = await source();
  const m = src.match(/async function phaseRestoreConf[\s\S]*?\n\}/);
  assert.ok(m, '必须存在 phaseRestoreConf');
  assert.match(m[0], /skippedReason/, '没有 conf 时必须给原因，不能静默跳过');
  // M55：把 `if (!confFile)` 改成 `if (false)` 后，没有 conf 时会一路走到底去调远端脚本，
  // 结果是「备份包里没有 conf」被当成「恢复 conf 失败」，报错信息误导人。
  assert.match(
    m[0],
    /if \(!confFile\) \{/,
    '必须真的用 confFile 做前置判断，而不是恒假的守卫',
  );
});

test('CRA-5b 没有 conf 时不得发起任何远端调用（否则会把「包里没有」报成「恢复失败」）', async () => {
  const src = await source();
  const m = src.match(/async function phaseRestoreConf[\s\S]*?\n\}/);
  assert.ok(m, '必须存在 phaseRestoreConf');
  const guard = m[0].match(/if \(!confFile\) \{([\s\S]*?)\n  \}/);
  assert.ok(guard, '必须有 if (!confFile) 早退分支');
  assert.match(guard[1], /return\s*\{/, '早退分支必须直接 return，不能继续往下走');
  assert.doesNotMatch(guard[1], /execRemote|resolveConfHostPathOrWarn/, '早退分支里不得有任何远端调用');
});

test('CRA-6 没有宿主机路径时 phaseRestoreConf 不得就地改容器（只读挂载必失败）', async () => {
  const src = await source();
  const m = src.match(/async function phaseRestoreConf[\s\S]*?\n\}/);
  assert.ok(m, '必须存在 phaseRestoreConf');
  assert.doesNotMatch(m[0], /docker exec[^\n]*sed -i/,
    '容器内 sed -i 对只读单文件 bind mount 必然失败');
});
