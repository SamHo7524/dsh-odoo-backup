/**
 * v0.3.0 真机缺陷修复（2026-11-24 恢复演练，测试机 134.175.51.9）：
 *
 * `phaseD_switch` 的 dbfilter 回写原先用
 *     docker exec -u root $OC sh -c "sed -i ... \$CONF"
 * 在真机上**必然失败**，而且失败是静默的（`2>/dev/null || true` + 非 0 退出被吞）：
 *
 *   1. 1Panel 把 odoo-hardening.conf 以**只读**单文件 bind mount 挂进容器
 *      （`docker inspect` → `rw=false`；容器内 `/proc/mounts` → `ext4 ro`）；
 *   2. 即便可写，`sed -i` 也需要 rename 临时文件，对单文件 bind mount 会报
 *      `sed: cannot rename ...: Device or resource busy`（实测 rc=4）；
 *   3. 于是"改 dbfilter"从来没成功过，而 `parseDbFilterOk` 又从另一个
 *      （可写、但 Odoo 不读的）`/etc/odoo/odoo.conf` 读回 → applied:true 假阳性。
 *
 * 还有第四个必须一起修的事实：Odoo 只在**进程启动时** `config.parse_config()`
 * 解析一次 dbfilter（`odoo/cli/server.py:97`），没有 reload 通道。所以即使写成功，
 * 不重启也不生效 —— 旧注释 "dbfilter 是请求期生效的配置，无需再次重启" 是错的。
 *
 * 修法：**在宿主机侧改宿主文件**（它是普通文件，`sed -i` 正常），
 *       然后重启容器让 Odoo 重新解析。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildSwitchScript,
  buildResolveConfHostPathScript,
  parseConfHostPath,
  parseDbFilterOk,
} from '../lib/restore.js';

// ---------------- DBFH-1~3：容器内写入必须彻底消失
//
// 注意：只检查**可执行行**。修复说明的注释里必须能写出旧的错误写法
// （否则后来者不知道为什么要改成宿主机写入），注释不是代码。

function executableLines(s) {
  return String(s)
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'));
}

test('DBFH-1 切换脚本不得再用 docker exec + sed -i 改容器内 conf（只读 bind mount 必失败）', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  const bad = /docker exec[^\n]*sed -i/;
  assert.doesNotMatch(code, bad, '容器内 sed -i 改只读 bind mount 必然失败，必须改走宿主机文件');
});

test('DBFH-2 可执行行里不得用 $CONF 做写入目标（只能用于回读）', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  const writeLines = code
    .split('\n')
    .filter((l) => /sed -i|>>\s*"?\$CONF\b|>\s*"?\$CONF\b|tee .*\$CONF/.test(l));
  for (const l of writeLines) {
    assert.doesNotMatch(
      l,
      /\$CONF\b/,
      `写入命令仍在操作容器内路径：${l.trim().slice(0, 120)}`,
    );
  }
});

test('DBFH-3 切换脚本必须用宿主机路径变量写入（CONF_HOST）', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  assert.match(code, /read -r CONF_HOST/, '必须从 stdin 读入宿主机侧 conf 路径');
  assert.match(code, /sed -i[^\n]*"\$CONF_HOST"/, '写入必须发生在宿主机文件上');
});

test('DBFH-3b 追加的键名必须与回读用的键名完全一致（大小写敏感）', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  // 写入行：printf 'dbfilter = ^%s$\nlist_db = False\n' "$DB" >> "$CONF_HOST"
  const w = code.match(/printf\s+'([A-Za-z_]+)\s*=\s*\^%s/);
  assert.ok(w, '必须存在追加 dbfilter 行的 printf');
  assert.equal(w[1], 'dbfilter', 'odoo.conf 的键名是小写 dbfilter；写成 DBFILTER 会被 Odoo 静默忽略');

  // 回读行也必须用同一个键名，否则「写对了但读错键」会一直报 applied:false
  const r = code.match(/grep -cE '\^([A-Za-z_]+)\[/);
  assert.ok(r, '必须存在回读 dbfilter 的 grep');
  assert.equal(r[1], w[1], `写入键名 ${w[1]} 与回读键名 ${r[1]} 不一致，读写契约断裂`);
});

// ---------------- DBFH-4~6：写后必须重启才生效

test('DBFH-4 写完 dbfilter 必须重启容器（Odoo 只在启动时解析一次）', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  // 必须锚定在「真正写 dbfilter 那一行」之后。
  // 不能从 C O N F _ H O S T 第一次出现处开始找 —— 前面 D7 的 `docker start`
  // 会让 /docker stop[\s\S]*docker start/ 误配（M43 就是这么活下来的）。
  const iWrite = code.search(/>>\s*"\$CONF_HOST"/);
  assert.ok(iWrite > 0, '必须存在向 $CONF_HOST 追加 dbfilter 的写入行');
  const after = code.slice(iWrite);
  assert.match(
    after,
    /docker restart\s+"?\$OC"?/,
    'Odoo 用 config.parse_config() 在启动时读一次 dbfilter，写文件后必须 docker restart 才生效',
  );
});

test('DBFH-5 回读验证必须从容器内读（证明 Odoo 真的能看到），不能只读宿主文件', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  assert.match(code, /docker exec[^\n]*grep[^\n]*\$CONF/, '必须从容器内回读，宿主读到不等于 Odoo 读到');
});

test('DBFH-6 写入失败必须显式报错，不能 2>/dev/null || true 静默吞掉', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  const idx = code.search(/CONF_HOST/);
  const seg = code.slice(Math.max(0, idx - 400), idx + 800);
  assert.doesNotMatch(
    seg,
    /sed -i[^\n]*2>\/dev\/null[^\n]*\|\| true/,
    'dbfilter 写入是安全相关步骤，失败必须可被发现',
  );
  assert.match(seg, /DBFILTER_RC/, '写入退出码必须被记录');
});

test('DBFH-6b 拿不到宿主机路径时必须是失败态，不能当成功继续（M47）', () => {
  const code = executableLines(buildSwitchScript()).join('\n');
  // else 分支 = 没有 CONF_HOST 或文件不存在
  const m = code.match(/else\s*\n\s*DBFILTER_RC=(\d+)/);
  assert.ok(m, '必须存在 CONF_HOST 缺失时的 else 分支');
  assert.notEqual(Number(m[1]), 0, '拿不到宿主机路径却把 RC 置 0 → 会继续重启并报告「已写入」，是假成功');
});

// ---------------- DBFH-7~10：宿主机路径解析

test('DBFH-7 必须提供「容器内路径 → 宿主机源路径」的解析脚本', () => {
  const s = buildResolveConfHostPathScript();
  assert.match(s, /docker inspect/, '要从 Mounts 表反查宿主机源路径');
  assert.match(s, /Destination/, 'docker inspect 模板必须含 .Destination');
  assert.match(s, /Source/, 'docker inspect 模板必须含 .Source');
  assert.doesNotMatch(s, /^set -e/m, '不要 set -e（要自己判退出码）');
  assert.doesNotMatch(s, /\|\s*head\b/, 'pipefail 下接 head 会提前退出');
});

test('DBFH-7b 解析脚本必须按 destination 匹配后打印 source，不能打印整张挂载表（M44）', () => {
  const code = executableLines(buildResolveConfHostPathScript()).join('\n');
  // 只出现 docker inspect / Destination / Source 字样不足以证明「映射」存在。
  // M44 把 awk 换成 `| true` 后，脚本仍然含这三样字样，但已不再做映射。
  assert.match(
    code,
    /\$1\s*==\s*d\s*\{[^}]*print\s+\$2/,
    '必须按 destination 精确匹配后打印 source，否则会把整张挂载表当路径',
  );
});

test('DBFH-7c 解析脚本禁止用正则/子串匹配 destination', () => {
  const code = executableLines(buildResolveConfHostPathScript()).join('\n');
  assert.doesNotMatch(
    code,
    /\$1\s*~/,
    '正则匹配会让 /etc/odoo/odoo.conf 先命中 /etc/odoo/odoo-hardening.conf，取到错误的源路径',
  );
  assert.doesNotMatch(code, /index\(\$1/, '子串匹配有同样的误命中问题');
});

test('DBFH-7d parseConfHostPath 从真实多挂载表里挑对那一条', () => {
  const real = [
    '===CONFHOST===',
    '/mnt/extra-addons|/opt/1panel/apps/odoo/odoo/data/addons',
    '/etc/odoo/odoo-hardening.conf|/opt/1panel/apps/odoo/odoo/data/conf/odoo-hardening.conf',
    '/var/lib/odoo|/opt/1panel/apps/odoo/odoo/data/data',
    'conf_host=/opt/1panel/apps/odoo/odoo/data/conf/odoo-hardening.conf',
    'conf_host_ok=1',
    '===END===',
  ].join('\n');
  const r = parseConfHostPath(real);
  assert.equal(r.ok, true);
  assert.equal(r.path, '/opt/1panel/apps/odoo/odoo/data/conf/odoo-hardening.conf');
});

test('DBFH-8 parseConfHostPath 解析出宿主机路径', () => {
  const out = [
    '===CONFHOST===',
    'conf_host=/opt/1panel/apps/odoo/odoo/data/conf/odoo-hardening.conf',
    'conf_host_ok=1',
    '===END===',
  ].join('\n');
  const r = parseConfHostPath(out);
  assert.equal(r.ok, true);
  assert.equal(r.path, '/opt/1panel/apps/odoo/odoo/data/conf/odoo-hardening.conf');
});

test('DBFH-9 parseConfHostPath 找不到映射时 ok=false 并给原因（不能猜）', () => {
  const out = ['===CONFHOST===', 'conf_host=', 'conf_host_ok=0', '===END==='].join('\n');
  const r = parseConfHostPath(out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /映射|挂载|mount/i);
});

test('DBFH-10 parseConfHostPath 段缺失时 ok=false（不能当成功）', () => {
  const r = parseConfHostPath('===SOMETHING===\nnothing\n');
  assert.equal(r.ok, false);
});

// ---------------- DBFH-11：回读语义

test('DBFH-11 parseDbFilterOk 仍要求 >=1 行有效 dbfilter（保持既有契约）', () => {
  assert.equal(parseDbFilterOk('===DBFILTER===\ndbfilter_ok=1\n===OLDDB===').applied, true);
  assert.equal(parseDbFilterOk('===DBFILTER===\ndbfilter_ok=0\n===OLDDB===').applied, false);
  assert.equal(parseDbFilterOk('===START===\nok\n===OLDDB===').applied, false);
});
