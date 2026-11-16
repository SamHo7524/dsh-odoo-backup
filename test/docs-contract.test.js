/**
 * v0.2.0 改名与 Odoo 20 支持的文档契约。
 *
 * 用户要求（2026-11-16）：
 *  1. 插件源码改名 dsh-odoo19-backup → dsh-odoo-backup；
 *  2. Odoo 20 已实测可备份/恢复，但 README 必须写明
 *     「备份与恢复需在同一大版本下进行，跨大版本不支持」；
 *  3. README / CHANGELOG / 发布脚本随之更新。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const V = pkg.version;
const V_RE = V.replace(/\./g, '\\.');

test('DOC-1 包名与两份 README 标题统一为 dsh-odoo-backup', () => {
  assert.equal(pkg.name, '@local/dsh-odoo-backup');
  assert.match(read('README.md'), /^# dsh-odoo-backup$/m);
  assert.match(read('README.zh-CN.md'), /^# dsh-odoo-backup$/m);
  assert.match(read('README.md'), /@local\/dsh-odoo-backup/);
  assert.match(read('README.zh-CN.md'), /@local\/dsh-odoo-backup/);
});

test('DOC-2 两份 README 的当前版本与安装源指向新仓库新版本', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, new RegExp('Current version: `' + V_RE + '`'));
  assert.match(zh, new RegExp('当前版本：`' + V_RE + '`'));
  for (const t of [en, zh]) {
    assert.match(t, new RegExp('github:SamHo7524/dsh-odoo-backup#v' + V_RE),
      '安装源必须是新仓库名与新版本');
    // 旧安装源/旧包文件不得再出现（历史沿革由 CHANGELOG 承载）
    assert.ok(!/dsh-odoo19-backup#v/.test(t), 'README 仍有旧安装源');
    assert.ok(!/dsh-odoo19-backup-\d/.test(t), 'README 仍有旧 tgz 名');
  }
});

test('DOC-3 README 明确 Odoo 19/20 支持，且备份与恢复必须同大版本', () => {
  const en = read('README.md');
  const zh = read('README.zh-CN.md');
  assert.match(en, /Odoo 20/);
  assert.match(en, /same major version/i);
  assert.match(en, /cross-major/i);
  assert.match(zh, /Odoo 20/);
  assert.match(zh, /同大版本/);
  assert.match(zh, /跨大版本/);
  assert.match(zh, /不支持/);
  // 旧文案「仅支持 Odoo 19」必须消失
  assert.ok(!/Odoo 19 only/i.test(en), 'EN README 仍写 only Odoo 19');
  assert.ok(!/仅支持 Odoo 19/.test(zh), '中文 README 仍写仅支持 Odoo 19');
});

test('DOC-4 两份 CHANGELOG 都有当前版本章节', () => {
  for (const f of ['CHANGELOG.md', 'CHANGELOG.zh-CN.md']) {
    assert.match(read(f), new RegExp('^## \\[' + V_RE + '\\]', 'm'), `${f} 缺 ${V} 章节`);
  }
});

test('DOC-5 发布与同步脚本指向新仓库与新 tgz 名', () => {
  const pub = read('scripts/publish-release.mjs');
  assert.match(pub, /OWNER_REPO\s*=\s*'SamHo7524\/dsh-odoo-backup'/);
  assert.match(pub, /dsh-odoo-backup-\$\{version\}\.tgz/);
  const sync = read('scripts/release-sync-check.mjs');
  assert.match(sync, /repos\/SamHo7524\/dsh-odoo-backup/);
  // 历史版本附件仍是旧包名，兼容列表必须保留，否则旧 Release 会被判漂移
  assert.match(sync, /dsh-odoo19-backup-\$\{v\}\.tgz/);
});