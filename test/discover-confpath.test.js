/**
 * 真机缺陷（2026-11-24 恢复演练，测试机 odoo.toogel.cn / 134.175.51.9）：
 *
 *   容器实际生效的配置是 ODOO_RC=/etc/odoo/odoo-hardening.conf，
 *   而 lib/discover.js 写死读 /etc/odoo/odoo.conf。
 *
 * 因为容器里 /etc/odoo/odoo.conf 也存在（816 B，几乎全是注释掉的默认值），
 * 探测不会报错，反而更隐蔽：
 *
 *   1. dbfilter 从**没人读的文件**里读出来 → 读到的是注释行 → dbName 为空；
 *   2. phaseD_switch 把 dbfilter 写回同一个没人读的文件；
 *   3. parseDbFilterOk 又从同一个文件读回 applied:true → **假阳性**。
 *
 * 本次演练两处 dbfilter 都是 ^toogel$，所以没有实际损失；
 * 但只要目标机的 dbfilter 需要改写，就会出现「报告说改好了、实际没生效」。
 *
 * 同一批证据还暴露了 backup.js 的 conf 收集缺陷：
 *   它只找 /opt/1panel/apps/odoo/odoo/data/conf/odoo.conf（`odoo`），
 *   而生产与测试机的真实路径是 .../odoo/odoo19/data/conf/odoo.conf（`odoo19`，
 *   也就是 <app>/<version> 两级），于是 MANIFEST.conf.present 恒为 false。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { parseInspect, resolveConfPath } from '../lib/discover.js';
import { buildConfCandidateShell, buildPackScriptForTest } from '../lib/backup.js';

// ---------------------------------------------------------------- ODOO_RC 解析

test('DCP-1 parseInspect 提取 ODOO_RC', () => {
  const r = parseInspect(
    ['HOST=pg', 'USER=u', 'ODOO_RC=/etc/odoo/odoo-hardening.conf', '---MOUNTS---', '---IMAGE---', 'sha256:x'].join('\n'),
  );
  assert.equal(r.odooRc, '/etc/odoo/odoo-hardening.conf');
});

test('DCP-2 没有 ODOO_RC 时为空串（不能瞎猜成 odoo.conf）', () => {
  const r = parseInspect(['HOST=pg', 'USER=u', '---MOUNTS---', '---IMAGE---', 'x'].join('\n'));
  assert.equal(r.odooRc, '');
});

test('DCP-3 resolveConfPath 优先 ODOO_RC', () => {
  assert.equal(
    resolveConfPath({ odooRc: '/etc/odoo/odoo-hardening.conf' }),
    '/etc/odoo/odoo-hardening.conf',
  );
});

test('DCP-4 resolveConfPath 无 ODOO_RC 时回退默认路径', () => {
  assert.equal(resolveConfPath({ odooRc: '' }), '/etc/odoo/odoo.conf');
  assert.equal(resolveConfPath({}), '/etc/odoo/odoo.conf');
  assert.equal(resolveConfPath(), '/etc/odoo/odoo.conf');
});

test('DCP-5 resolveConfPath 拒绝相对路径与带 .. 的路径（防注入进 docker exec）', () => {
  assert.equal(resolveConfPath({ odooRc: 'relative/odoo.conf' }), '/etc/odoo/odoo.conf');
  assert.equal(resolveConfPath({ odooRc: '/etc/../../etc/passwd' }), '/etc/odoo/odoo.conf');
  assert.equal(resolveConfPath({ odooRc: '/etc/odoo/x;rm -rf /' }), '/etc/odoo/odoo.conf');
});

test('DCP-6 resolveConfPath 去引号与空白', () => {
  assert.equal(resolveConfPath({ odooRc: '  "/etc/odoo/a.conf"  ' }), '/etc/odoo/a.conf');
});

// ------------------------------------------------------- backup 侧 conf 候选路径

test('DCP-7 conf 候选路径必须覆盖 <app>/<version>/data/conf 两级层级', () => {
  const sh = buildConfCandidateShell();
  assert.match(sh, /\/opt\/1panel\/apps\/odoo\/\*\/data\/conf\/odoo\.conf/, '必须用通配匹配 <app>/<version>');
});

test('DCP-8 conf 候选路径必须仍覆盖旧的单级路径（向后兼容）', () => {
  const sh = buildConfCandidateShell();
  assert.match(sh, /\/opt\/1panel\/apps\/odoo\/odoo\/data\/conf\/odoo\.conf/);
});

test('DCP-9 conf 候选路径优先跟随 ODOO_RC（容器内实际生效的那份）', () => {
  const sh = buildConfCandidateShell();
  // 用 ODOO_RC 反查宿主机挂载源，比硬编码猜路径更可靠
  assert.match(sh, /ODOO_RC/);
  assert.match(sh, /docker inspect[\s\S]*Mounts/);
});

test('DCP-10 conf 候选 shell 不以 set -e 开头且不接 head', () => {
  const sh = buildConfCandidateShell();
  assert.doesNotMatch(sh, /^set -e/m);
  assert.doesNotMatch(sh, /\|\s*head\b/);
});

// ------------------------------------------------- pack 脚本的 stdin / OC 契约
// 「候选路径写得好」不等于「远端真的拿到了容器名」——DCP-9 只能证明 shell 里读了 OC，
// 不能证明 stdin 里给了它。这两条锁住「参数真的送达」。

test('DCP-11 pack 脚本必须从 stdin 读容器名（否则 ODOO_RC 分支永远是死代码）', () => {
  const sh = buildPackScriptForTest();
  assert.match(sh, /^read -r OC$/m, 'pack 脚本必须 read -r OC');
  const reads = sh.match(/^read -r (\w+)$/gm) ?? [];
  assert.deepEqual(
    reads.map((r) => r.replace('read -r ', '')),
    ['ADDONS', 'PYDATA', 'OUTDIR', 'TS', 'OC'],
    'stdin 行顺序一旦变化，远端就会把容器名读进别的变量',
  );
});

test('DCP-12 buildPackScript 的调用方必须把 odooContainer 作为第 5 行传下去', async () => {
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../lib/backup.js', import.meta.url), 'utf8');
  assert.match(src, /instance\.odooContainer \?\? ''/, '调用方必须把容器名拼进 stdin');
});

