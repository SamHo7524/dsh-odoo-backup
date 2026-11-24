/**
 * v0.3.0 真机缺陷修复（2026-11-24 恢复演练，测试机 134.175.51.9）：
 *
 * 演练时 MANIFEST 里 `conf.present` 恒为 false，问到根因是**备份侧找错文件**
 * （硬编码 `/opt/1panel/apps/odoo/odoo/data/conf/odoo.conf`，而真机是
 *  `/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf` 或 `odoo-hardening.conf`）。
 * 那部分已在 lib/backup.js 的 buildConfCandidateShell 修掉。
 *
 * 但还有更严重的一半：**恢复侧从来不恢复 odoo.conf**。
 * `extractBundle` 只挑 `dump.zip` / `addons-*` / `pydeps-*`，
 * MANIFEST 里即使有 conf 也永远回不到目标机。
 *
 * 这一半不能简单「拷回去」就完事，有两个硬约束：
 *
 *   1. 备份里的 `admin_passwd` 是**脱敏的字面量** `<REDACTED>`
 *      （lib/backup.js 用 sed 替换，避免密钥进包）。
 *      直接拷回去等于把管理员口令设成一个公开已知的字符串 —— 那是**降级**。
 *      所以必须：新 conf 里剔掉这行，再把**目标机原有的那行**原样接回去；
 *      密钥全程不出远端。
 *
 *   2. 目标机原来的 conf 必须**先留副本**再覆盖，否则「恢复配置」变成
 *      「销毁配置」，用户连对照都没有了。
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONF_REDACTED,
  stripRedactedAdminPasswd,
  buildConfRestoreScript,
  parseConfRestore,
} from '../lib/restore.js';

// ---------------- CR-1~3：脱敏行必须被剔除（否则是安全降级）

test('CR-1 stripRedactedAdminPasswd 剔掉 <REDACTED> 那一行，其余原样保留', () => {
  const src = [
    '[options]',
    'addons_path = /mnt/extra-addons',
    'admin_passwd = <REDACTED>',
    'db_name = tg-odoo',
    'proxy_mode = True',
    '',
  ].join('\n');
  const r = stripRedactedAdminPasswd(src);
  assert.equal(r.stripped, 1);
  assert.doesNotMatch(r.text, /admin_passwd/);
  assert.match(r.text, /addons_path = \/mnt\/extra-addons/);
  assert.match(r.text, /db_name = tg-odoo/);
  assert.match(r.text, /proxy_mode = True/);
});

test('CR-2 大小写与多余空白都要识别（sed 不保证输出格式统一）', () => {
  const src = '[options]\n  ADMIN_PASSWD   =   <REDACTED>   \nfoo = bar\n';
  const r = stripRedactedAdminPasswd(src);
  assert.equal(r.stripped, 1);
  assert.match(r.text, /foo = bar/);
});

test('CR-3 真实口令行（不是脱敏占位符）必须保留 —— 那是用户自己的配置', () => {
  // 万一将来备份不再脱敏，这里也不能把真口令删掉
  const src = '[options]\nadmin_passwd = someRealSecret\nfoo = bar\n';
  const r = stripRedactedAdminPasswd(src);
  assert.equal(r.stripped, 0);
  assert.match(r.text, /admin_passwd = someRealSecret/);
});

test('CR-4 占位符常量与 backup.js 的 sed 输出一致（跨模块契约）', () => {
  assert.equal(CONF_REDACTED, '<REDACTED>');
});

// ---------------- CR-5~8：远端脚本安全契约

test('CR-5 覆盖目标 conf 之前必须先留副本', () => {
  const s = buildConfRestoreScript();
  const code = s.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  // 副本路径与 cp 可能分两行（BACKUP=... 再 cp -a），分别断言存在且顺序正确
  const iBak2 = code.search(/BACKUP= *"\$TARGET\.dsh-bak-\$TS"/);
  assert.ok(iBak2 > 0, '必须先算出 .dsh-bak-<ts> 副本路径');
  const iCp = code.search(/cp -a[^\n]*"\$TARGET"[^\n]*"\$BACKUP"/);
  assert.ok(iCp > 0, '必须用 cp -a 保留原 conf');
  // 写入形态：覆盖路径经 `grep -vF '<REDACTED>' "$NEWCONF" > "$TARGET"`（纵深防御），
  // 不再是裸 cat（裸 cat 会把脱敏占位符写进真配置，见 CR-6e）。
  const iOverwrite = code.search(/(?:cat|grep)[^\n]*"\$NEWCONF"[^\n]*> *"\$TARGET"/);
  assert.ok(iOverwrite > 0, '必须写入新 conf');
  assert.ok(iCp < iOverwrite, '备份必须发生在覆盖之前，否则「恢复配置」会变成「销毁配置」');
});

test('CR-6 必须把目标机原有 admin_passwd 原样接回去（密钥不出远端）', () => {
  const s = buildConfRestoreScript();
  const code = s.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  assert.match(code, /grep[^\n]*admin_passwd[^\n]*"\$TARGET"/, '必须先从旧 conf 取出 admin_passwd 行');
  assert.match(code, /printf[^\n]*"\$_ap"[^\n]*>> *"\$TARGET"/, '必须把它追加回新 conf');
  // 绝不允许把口令值打印出来
  assert.doesNotMatch(code, /echo[^\n]*\$_ap/, '不得 echo admin_passwd 的值');
  assert.doesNotMatch(code, /echo[^\n]*\$_ap\b/, '不得 echo admin_passwd 的值');
  assert.match(code, /conf_admin_passwd_kept=\$KEPT/, '只能输出「是否保留了」的布尔标志');
});

test('CR-6b 取出 admin_passwd 后必须真的置 KEPT=1（M57：不置位就等于没保留也不上报）', () => {
  const code = buildConfRestoreScript()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  assert.match(
    code,
    /if \[ -n "\$_ap" \]; then KEPT=1; fi/,
    'KEPT 必须由 $_ap 非空驱动；少了这一行，接口会一直报「未保留」，用户无从判断口令是否延续',
  );
});

test('CR-6c 回接的 admin_passwd 必须排除备份里的脱敏占位符', () => {
  const code = buildConfRestoreScript()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  // 只 grep 到 <REDACTED> 那行就接回去 = 把口令降级成公开已知字符串
  assert.match(
    code,
    /grep -vF '<REDACTED>'/,
    '回接前必须过滤掉脱敏占位符，否则会把 <REDACTED> 当成真口令写回去',
  );
});

test('CR-6d 目标机原本没有 admin_passwd 时不得凭空造一个（KEPT 保持 0）', () => {
  const code = buildConfRestoreScript()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  // 追加动作必须在 `[ -n "$_ap" ]` 保护之下
  assert.match(
    code,
    /if \[ "\$CONF_RC" = "0" \] && \[ -n "\$_ap" \]; then\s*\n\s*printf/,
    '只有真的取到原值时才追加，不能无条件追加一行空口令',
  );
});

test('CR-6e 远端写入前必须再过滤一次占位符（纵深防御，不依赖上传侧）', () => {
  // 真机沙箱实测（2026-11-24）：只靠上传侧清洗时，远端脚本自身仍会把
  // `admin_passwd = <REDACTED>` 原样写进配置。两道过滤才可靠。
  const code = buildConfRestoreScript()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  const allWrites = code.match(/grep -vF '<REDACTED>' "\$NEWCONF"/g) ?? [];
  assert.ok(allWrites.length >= 2, `覆盖与新建两条写入路径都要过滤，实际 ${allWrites.length} 处`);
  assert.doesNotMatch(code, /cat "\$NEWCONF" > "\$TARGET"/, '不得出现未经过滤的直写');
});

test('CR-6f grep -v 把全部行过滤掉时不得误判为失败', () => {
  // `grep -v` 的退出码语义与普通命令不同：有输出=0，**全部被过滤=1**（此时目标文件合法且为空）。
  // 少了这个判别，一份只含占位符行的 conf 会「写成功却报失败」，
  // 上层据此以为配置没恢复，进而回滚或阻止切换。
  const code = buildConfRestoreScript()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('#'))
    .join('\n');
  assert.match(
    code,
    /grep -vF '<REDACTED>' "\$NEWCONF"[^\n]*\|\|[^\n]*\[ "\$\?" = "1" \][^\n]*\|\|/,
    'grep -v 的退出码 1（全部被过滤）必须显式视为成功',
  );
});

test('CR-7 拿不到宿主机路径时必须是失败态（不能当成功写容器内只读挂载）', () => {
  const s = buildConfRestoreScript();
  const code = s.split('\n').filter((l) => !l.trimStart().startsWith('#')).join('\n');
  const m = code.match(/else\s*\n\s*CONF_RC=(\d+)/);
  assert.ok(m, '必须存在宿主机路径缺失时的 else 分支');
  assert.notEqual(Number(m[1]), 0, '没有宿主机路径却置 0 会假装成功');
});

test('CR-8 不许 set -e、不许接 head（pipefail 下 SIGPIPE 会提前退出）', () => {
  const s = buildConfRestoreScript();
  assert.doesNotMatch(s, /^set -e/m);
  assert.doesNotMatch(s, /\|\s*head\b/);
  assert.match(s, /set -u/, '至少要 set -u');
});

// ---------------- CR-9~12：解析

test('CR-9 parseConfRestore 正常输出', () => {
  const out = [
    '===CONFRESTORE===',
    'conf_target=/opt/1panel/apps/odoo/odoo/data/conf/odoo-hardening.conf',
    'conf_backup=/opt/1panel/apps/odoo/odoo/data/conf/odoo-hardening.conf.dsh-bak-20261124150000',
    'conf_admin_passwd_kept=1',
    'CONF_RC=0',
    '===END===',
  ].join('\n');
  const r = parseConfRestore(out);
  assert.equal(r.ok, true);
  assert.equal(r.adminPasswdKept, true);
  assert.match(r.backupPath, /dsh-bak-/);
});

test('CR-10 parseConfRestore 段缺失时 ok=false（不能当成功）', () => {
  const r = parseConfRestore('===OTHER===\nnothing\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /缺失|不完整/);
});

test('CR-11 parseConfRestore 非 0 退出码要带原因，且 admin_passwd 未保留时要显式说明', () => {
  const out = [
    '===CONFRESTORE===',
    'conf_target=',
    'conf_backup=',
    'conf_admin_passwd_kept=0',
    'CONF_RC=97',
    '===END===',
  ].join('\n');
  const r = parseConfRestore(out);
  assert.equal(r.ok, false);
  assert.match(r.reason, /97|宿主机/);
});

test('CR-12 目标机原本没有 conf 时（纯新增）也算成功，但标志位要区分', () => {
  const out = [
    '===CONFRESTORE===',
    'conf_target=/opt/1panel/apps/odoo/odoo/data/conf/odoo.conf',
    'conf_backup=',
    'conf_created=1',
    'conf_admin_passwd_kept=0',
    'CONF_RC=0',
    '===END===',
  ].join('\n');
  const r = parseConfRestore(out);
  assert.equal(r.ok, true);
  assert.equal(r.created, true);
  assert.equal(r.adminPasswdKept, false);
});
