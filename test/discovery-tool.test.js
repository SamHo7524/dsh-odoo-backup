import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { createOdooBackupTool } from '../lib/tools.js';

const SRC_TOOLS = readFileSync(new URL('../lib/tools.js', import.meta.url), 'utf8');
const SRC_SERVICE = readFileSync(new URL('../lib/service.js', import.meta.url), 'utf8');

function flat(s) {
  return s.replace(/\s+/g, ' ');
}

test('TDX-1 odoo_backup 的 action 枚举包含 scanExternalDeps', () => {
  assert.match(flat(SRC_TOOLS), /enum: \[\s*'test', 'discover', 'backup', 'listServers', 'fingerprint', 'pin', 'scanExternalDeps'/);
});

test('TDX-2 service 暴露 scanExternalDeps 且先过 requireTrusted（不绕过指纹闸门）', () => {
  assert.match(flat(SRC_SERVICE), /async scanExternalDeps\(name/);
  // 方法体内第一句必须是 requireTrusted —— 扫描要连远端，不能跳过主机指纹校验
  const m = SRC_SERVICE.match(/async scanExternalDeps\(name[^)]*\)\s*\{([\s\S]{0,400}?)\n\s{4}\},?/);
  assert.ok(m, '找不到 scanExternalDeps 方法体');
  assert.match(m[1], /requireTrusted\(name\)/);
});

test('TDX-3 工具 execute 里 scanExternalDeps 分支存在，并把 config 里的 extraPaths 透传下去', async () => {
  const servers = [
    { name: 'toogel', extraPaths: [{ name: 'vault', path: '/root/Documents/Obsidian Vault' }] },
  ];
  let seen = null;
  const tool = createOdooBackupTool({
    config: { servers },
    service: {
      async scanExternalDeps(name, extraPaths) {
        seen = { name, extraPaths };
        return { ok: true, readOnly: true, report: 'R' };
      },
    },
  });
  const value = await tool.execute({ action: 'scanExternalDeps', server: 'toogel' });
  assert.equal(value.ok, true);
  assert.equal(seen.name, 'toogel');
  assert.equal(seen.extraPaths.length, 1);
  assert.equal(seen.extraPaths[0].path, '/root/Documents/Obsidian Vault');
});

test('TDX-4 scanExternalDeps 结果在 render 里输出 report 正文（而不是只丢 JSON）', () => {
  const tool = createOdooBackupTool({ config: { servers: [] }, service: {} });
  const out = tool.output.render(
    { action: 'scanExternalDeps', server: 'toogel' },
    { ok: true, report: '### 报告正文\n建议新增：2', counts: { suggest: 2, covered: 3, confirm: 1, overflow: 0 } },
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'text');
  assert.match(out[0].text, /### 报告正文/);
  assert.match(out[0].text, /建议新增：2/);
});

test('TDX-5 工具描述里写明只读、不写配置（避免被当成 Phase 2 的入口）', () => {
  assert.match(flat(SRC_TOOLS), /scanExternalDeps[^']*只读/);
  assert.match(flat(SRC_TOOLS), /不写入配置|不修改配置/);
});
