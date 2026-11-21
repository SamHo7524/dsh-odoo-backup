/**
 * v0.2.2 T5 RED — Agent 工具与回执透出「额外路径」。
 *
 * 契约：
 *  - listServers 每台服务器暴露 extraPaths 条数（计数），密钥/指纹等敏感字段不外泄；
 *  - backup 结果对象的 extras 为数组，每项含 name/bytes/sha256；
 *  - render 在 backup 结果中追加「额外路径：vault 111.0 MB sha256 b51ca028…」一行；
 *  - 无额外路径时不追加该行。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createOdooBackupTool } from '../lib/tools.js';

const servers = [
  {
    name: 'toogel',
    host: '47.121.205.143',
    port: 22,
    user: 'root',
    keyPath: 'H:/odoo/key/odoo-backup',
    sshConfigAlias: '',
    pinnedFingerprint: 'SHA256:abc',
    extraPaths: [
      { name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'] },
      { name: 'hermes', path: '/root/.hermes', exclude: [] },
    ],
  },
  { name: 'staging', host: '119.29.10.202', port: 22, user: 'root' },
];

function makeBackupTool() {
  return createOdooBackupTool({ config: { servers }, service: {} });
}

test('TBX-1 listServers 每台服务器带 extraPaths 条数', async () => {
  const tool = makeBackupTool();
  const out = await tool.execute({ action: 'listServers' });
  assert.equal(out.servers.find((s) => s.name === 'toogel').extraPaths, 2);
  assert.equal(out.servers.find((s) => s.name === 'staging').extraPaths, 0);
});

test('TBX-2 listServers 不外泄密钥/别名/指纹等敏感字段', async () => {
  const tool = makeBackupTool();
  const out = await tool.execute({ action: 'listServers' });
  for (const s of out.servers) {
    assert.equal(s.keyPath, undefined, '不得泄露 keyPath');
    assert.equal(s.sshConfigAlias, undefined, '不得泄露 sshConfigAlias');
    assert.equal(s.pinnedFingerprint, undefined, '不得泄露 pinnedFingerprint');
  }
});

test('TBX-2b listServers 的文本回执要显示额外路径条数（否则用户看不出配了没）', async () => {
  const tool = makeBackupTool();
  const out = await tool.execute({ action: 'listServers' });
  const text = tool.output.render({ action: 'listServers' }, out)[0].text;
  // 配了 2 条的必须显式写出来；配 0 条的不啰嗦。
  assert.match(text, /toogel[^\n]*2 条额外路径/, `回执应显示 toogel 的额外路径条数，实际：${text}`);
  assert.doesNotMatch(text, /staging[^\n]*额外路径/, '没有额外路径的服务器不必显示该提示');
});

test('TBX-3 render 对 backup 结果追加额外路径摘要行', async () => {
  const tool = makeBackupTool();
  const rendered = tool.output.render({ action: 'backup' }, {
    ok: true,
    localPath: 'K:/b.tar.enc',
    extras: [
      { name: 'vault', bytes: 111 * 1024 * 1024, sha256: 'b51ca028' + '0'.repeat(56) },
    ],
  });
  assert.equal(rendered[0].type, 'text');
  const text = rendered[0].text;
  assert.match(text, /额外路径：vault 111\.0 MB sha256 b51ca028…/, '摘要行格式：名称 + 可读体积 + sha256 前缀');
  // 原始 JSON 结果仍完整保留
  assert.match(text, /localPath/, '摘要行不得覆盖原始结果');
});

test('TBX-4 无额外路径时 render 不显示额外路径行', async () => {
  const tool = makeBackupTool();
  const rendered = tool.output.render({ action: 'backup' }, {
    ok: true, localPath: 'K:/b.tar.enc',
  });
  assert.doesNotMatch(rendered[0].text, /额外路径/);
});

test('TBX-5 runBackup 返回体带 extras 数组（每项 name/bytes/sha256）', () => {
  const src = readFileSync(new URL('../lib/backup.js', import.meta.url), 'utf8');
  const returnIdx = src.lastIndexOf('return {');
  assert.ok(returnIdx > 0, '找不到 runBackup 的返回对象');
  const tail = src.slice(returnIdx);
  assert.match(tail, /extras:/, 'runBackup 返回体必须带 extras');

  // ⚠ 这里曾经断言 `extras:\s*extrasResult\.extras` —— 而 extrasResult 是
  // `if (!resumePlan)` 块内的 const，返回体在函数末尾，**那就是崩溃本身**。
  // 静态源码断言把 bug 写成了规格，全绿却挡不住 ReferenceError。
  // 现在只锁「返回体里的 extras 必须是能在函数作用域解析到的标识符」：
  // 该标识符必须在 `try {` 之前以 let/const/var 声明过。
  const m = tail.match(/extras:\s*([A-Za-z_$][\w$]*)\s*,/);
  assert.ok(m, 'extras 应直接引用一个标识符');
  const ident = m[1];
  // 作用域基准取 runBackup 函数体开头，而不是全文第一个 try（文件里前面还有别的 try）
  const fnIdx = src.indexOf('export async function runBackup');
  assert.ok(fnIdx > 0, '找不到 runBackup 定义');
  const tryIdx = src.indexOf('try {', fnIdx);
  assert.ok(tryIdx > fnIdx, 'runBackup 内找不到 try 块');
  const before = src.slice(fnIdx, tryIdx);
  assert.match(
    before,
    new RegExp(`(?:let|const|var)\\s+${ident}\\b`),
    `extras 引用的 ${ident} 必须在函数作用域（runBackup 的 try 之前）声明，否则会在 return 处抛 ReferenceError`,
  );

  // 行为层的权威验证在 backup-return-extras.test.js（RET-1/RET-2 真的跑到 return）。
});
