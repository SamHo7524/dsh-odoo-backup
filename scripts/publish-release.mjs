// 发布一个版本（幂等）。每次更新都必须同步的六件事，一处漏了就拒发或补齐：
//   package.json 版本 / 中英文 CHANGELOG / 中英文 README / 测试 / GitHub Release + .tgz 附件 / tag+push
//
// 用法：
//   node scripts/publish-release.mjs --dry-run                 只校验 + 测试 + 打包，不写远端
//   node scripts/publish-release.mjs                           发布 package.json 里的版本（全流程）
//   node scripts/publish-release.mjs --releases-only           只补 GitHub Release + 附件（tag 已存在的补发布）
//   node scripts/publish-release.mjs --releases-only --version 0.1.15   为历史版本补 Release
//
// 依赖：git 命令行 + git credential manager 里的 GitHub PAT（与 git push 同一份凭据）。
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const GIT = 'C:/Program Files/Git/cmd/git.exe';
const NODE = process.execPath;
const REPO = process.env.RELEASE_REPO || 'K:/Backup/odoo-plugin-releases/_gh-publish/repo';
const PKG_DIR = 'K:/Backup/odoo-plugin-releases/packages';
const OWNER_REPO = 'SamHo7524/dsh-odoo-backup';
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const releasesOnly = args.includes('--releases-only');
const versionArg = args.includes('--version') ? args[args.indexOf('--version') + 1] : null;

const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const version = versionArg || pkg.version;
const tag = `v${version}`;
const tgzName = `dsh-odoo-backup-${version}.tgz`;

const log = (m) => console.log(m);
const die = (m) => { console.error(`\nFAILED: ${m}`); process.exit(1); };
const run = (cmd, argv, opts = {}) => execFileSync(cmd, argv, { encoding: 'utf8', ...opts }).trim();
const runInRepo = (argv, opts) => run(GIT, ['-C', REPO, ...argv], opts);

let tokenCache;
const ghToken = () => {
  if (tokenCache) return tokenCache;
  const out = execFileSync(GIT, ['credential', 'fill'], {
    input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  });
  const line = out.split('\n').find((l) => l.startsWith('password='));
  if (!line) die('git credential fill 未返回 password（先 git push 一次以保存凭据）');
  return (tokenCache = line.slice('password='.length));
};

const ghHeaders = (extra = {}) => ({
  Authorization: `token ${ghToken()}`,
  'User-Agent': 'dsh-publish-release',
  Accept: 'application/vnd.github+json',
  ...extra,
});

async function ghApi(path, init = {}) {
  const clean = String(path).replace(/^\/+/, '');
  const r = await fetch(`https://api.github.com/repos/${OWNER_REPO}/${clean}`, { ...init, headers: ghHeaders(init.headers) });
  if (r.status === 404 && (init.method || 'GET') === 'GET') return null;
  if (!r.ok) die(`GitHub API ${init.method || 'GET'} ${path} -> ${r.status}: ${(await r.text()).slice(0, 400)}`);
  return r.status === 204 ? null : r.json();
}

// 从 CHANGELOG 抽出该版本章节，拼成 Release 说明（与历史 Release 保持同风格 + 双语链接）。
function releaseNotes(changelogText) {
  const lines = changelogText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(`## [${version}]`));
  if (start === -1) return null;
  const body = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    body.push(lines[i]);
  }
  // 只取概述段（到第一个 ### 之前），再补安装行。
  const summary = [];
  for (const l of body) {
    if (/^### /.test(l)) break;
    if (l.trim() === '---') break;
    summary.push(l);
  }
  const text = summary.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return `${text}\n\n---\n\nInstall: \`github:${OWNER_REPO}#${tag}\`\n\nDetails: [CHANGELOG.md](https://github.com/${OWNER_REPO}/blob/main/CHANGELOG.md) · [CHANGELOG.zh-CN.md](https://github.com/${OWNER_REPO}/blob/main/CHANGELOG.zh-CN.md)`;
}

// Release 标题沿用历史风格：「vX.Y.Z — 一句话摘要」（取自该版本章节的加粗概述首句）。
function releaseTitle(changelogText) {
  const lines = changelogText.split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim().startsWith(`## [${version}]`));
  if (start === -1) return tag;
  let first = '';
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i])) break;
    const t = lines[i].replace(/\*\*/g, '').trim();
    if (t && !t.startsWith('###') && t !== '---') { first = t; break; }
  }
  const short = first
    .replace(/`/g, '')
    .split(/(?<=[.。!?])\s/)[0]
    .replace(/[.。!?]$/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const capped = short.length > 64 ? `${short.slice(0, 64).replace(/\s+\S*$/, '')}…` : short;
  return capped ? `${tag} — ${capped}` : tag;
}

// ---------- 1. 文档一致性闸门 ----------
log(`=== publish ${tag}${dryRun ? ' (dry-run)' : ''}${releasesOnly ? ' (releases-only)' : ''} ===`);
const changelogEn = readFileSync(join(ROOT, 'CHANGELOG.md'), 'utf8');
const changelogZh = readFileSync(join(ROOT, 'CHANGELOG.zh-CN.md'), 'utf8');
if (!changelogEn.includes(`## [${version}]`)) die(`CHANGELOG.md 缺 ## [${version}] 章节`);
if (!changelogZh.includes(`## [${version}]`)) die(`CHANGELOG.zh-CN.md 缺 ## [${version}] 章节`);
log('✓ 中英文 CHANGELOG 均有该版本章节');

if (!releasesOnly) {
  const readmeEn = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const readmeZh = readFileSync(join(ROOT, 'README.zh-CN.md'), 'utf8');
  if (pkg.version !== version) die(`package.json(${pkg.version}) 与目标版本(${version}) 不一致`);
  if (!readmeEn.includes(`Current version: \`${version}\``)) die(`README.md 当前版本不是 ${version}`);
  if (!readmeZh.includes(`当前版本：\`${version}\``)) die(`README.zh-CN.md 当前版本不是 ${version}`);
  if (!readmeEn.includes(`#${tag}`) || !readmeZh.includes(`#${tag}`)) die(`README 安装源未指向 #${tag}`);
  log('✓ 中英文 README 版本号与安装源一致');
}

// ---------- 2. 测试 ----------
if (!releasesOnly) {
  log('=== tests ===');
  // v0.1.27：串行执行（--test-concurrency=1）。
  // 若干既有测试（service-v0113 / v0117-fix 等）共用固定状态目录与锁文件，
  // 并行跑时偶发互相踩踏（SVC-3 / V17-S2 间歇性失败），会让发布门禁误报。
  // 串行后连续 3 次稳定 646/646，代价是耗时略增，换来门禁可信。
  //
  // v0.2.5：测试失败时必须给出**可读的失败清单**。此前 execFileSync 直接抛异常，
  // 控制台只剩一大坨带转义符的输出，看不出到底哪条红了 —— 门禁拦住了但没人看懂。
  let out = '';
  try {
    out = execFileSync(NODE, ['--test', '--test-concurrency=1', 'test/**/*.test.js'],
      { cwd: ROOT, encoding: 'utf8' });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
  const lines = out.split('\n');
  const num = (re) => lines.map((l) => l.match(re)).filter(Boolean).at(-1)?.[1];
  const pass = num(/^# pass (\d+)/) ?? num(/^ℹ pass (\d+)/) ?? '0';
  const fail = num(/^# fail (\d+)/) ?? num(/^ℹ fail (\d+)/) ?? '?';
  log(`  pass=${pass} fail=${fail}`);

  if (fail !== '0') {
    // 提取失败用例名与首行错误，直接打到 console.error ——— 便于一眼定位。
    const failed = [...new Set(lines.map((l) => l.match(/^✖ (.+?) \(/)?.[1]).filter(Boolean))];
    const errors = [...new Set(lines
      .map((l) => l.match(/^\s+(TypeError|ReferenceError|AssertionError|Error): (.+)$/)?.[0]?.trim())
      .filter(Boolean))];
    console.error('\n失败用例：');
    for (const f of failed.slice(0, 20)) console.error(`  ✖ ${f}`);
    if (errors.length) {
      console.error('\n错误摘要：');
      for (const e of errors.slice(0, 10)) console.error(`  ${e}`);
    }
    die(`测试未全部通过（fail=${fail}）—— 修好再发版`);
  }
}

// ---------- 3. 打包（统一命名 dsh-odoo-backup-X.Y.Z.tgz） ----------
log('=== pack ===');
mkdirSync(PKG_DIR, { recursive: true });
const finalTgz = join(PKG_DIR, tgzName);
if (!existsSync(finalTgz)) {
  if (pkg.version !== version) {
    die(`缺少 ${tgzName}，且工作区版本(${pkg.version}) ≠ 目标(${version})；拒绝用错误内容打包，请先把该版本的 tarball 放进 ${PKG_DIR}`);
  }
  const pnpm = join(dirname(NODE), '..', '..', 'pnpm', 'bin', 'pnpm.mjs');
  if (!existsSync(pnpm)) die(`找不到 pnpm: ${pnpm}`);
  const tmp = join(tmpdir(), `pack-${version}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  execFileSync(NODE, [pnpm, 'pack', '--pack-destination', tmp], { cwd: ROOT, encoding: 'utf8' });
  const { readdirSync } = await import('node:fs');
  const tgz = readdirSync(tmp).find((f) => f.endsWith('.tgz'));
  if (!tgz) die('打包未产出 .tgz');
  copyFileSync(join(tmp, tgz), finalTgz);
  rmSync(tmp, { recursive: true, force: true });
  log(`  ${tgz} -> ${tgzName}`);
} else {
  log(`  复用已有 ${tgzName}`);
}

// ---------- 3b. 验证「真正要发出去的那个 tgz」 ----------
// v0.2.5：这一步是补上的门禁。此前只测工作区源码，而发出去的是 tgz ——
// v0.2.2 的 `z.number().nullable()` 就是「工作区能跑、装进 profile 才炸」，
// 所以必须解开 tgz、用真实 schemastery 加载包内的 index.js，而不是相信工作区。
log('=== verify packed artifact ===');
{
  const { readdirSync, mkdtempSync, writeFileSync } = await import('node:fs');
  const { spawnSync } = await import('node:child_process');

  // 解到 ROOT 下，这样包内 index.js 向上能找到 ROOT/node_modules（peerDependency 解析路径）
  const sandbox = join(ROOT, `.packcheck-${version}-${Date.now()}`);
  mkdirSync(sandbox, { recursive: true });
  try {
    execFileSync('tar', ['-xzf', finalTgz, '-C', sandbox], { encoding: 'utf8' });

    const pkgRoot = join(sandbox, 'package');
    if (!existsSync(join(pkgRoot, 'index.js'))) die('tgz 内缺少 index.js');

    // 包的 essentials 必须齐（少文件 = 装上也白装）
    for (const rel of ['index.js', 'client.js', 'cordis.patch.yml', 'lib/backup.js',
      'lib/extra-paths.js', 'lib/extras-runner.js', 'lib/local-space.js', 'lib/tools.js',
      'lib/service.js', 'locale/zh.json', 'locale/en.json']) {
      if (!existsSync(join(pkgRoot, rel))) die(`tgz 内缺少 ${rel}`);
    }

    // 包内 package.json 的版本必须与目标版本一致
    const packedPkg = JSON.parse(readFileSync(join(pkgRoot, 'package.json'), 'utf8'));
    if (packedPkg.version !== version) {
      die(`tgz 内 package.json 版本(${packedPkg.version}) ≠ 目标(${version})`);
    }
    // 包内不能混进 node_modules / test / .packcheck
    if (existsSync(join(pkgRoot, 'node_modules'))) die('tgz 内不应包含 node_modules');
    if (existsSync(join(pkgRoot, 'test'))) die('tgz 内不应包含 test 目录');

    // 真正加载包内 index.js（子进程隔离，避免污染本进程的模块缓存）
    const probe = join(sandbox, '_probe.mjs');
    writeFileSync(probe, [
      "const m = await import('./package/index.js');",
      "const parsed = m.Config({ servers: [{ name: 'toogel', host: 'h',",
      "  extraPaths: [{ name: 'vault', path: '/root/v', exclude: ['./.git'], maxBytes: null }] }] });",
      "const servers = m.unwrapVolatile(parsed.servers);",
      "if (servers[0].extraPaths[0].maxBytes !== null) throw new Error('maxBytes 未保留 null');",
      "console.log('PACKED_IMPORT_OK ' + Object.keys(m).join(','));",
    ].join('\n'), 'utf8');

    const r = spawnSync(NODE, [probe], { cwd: sandbox, encoding: 'utf8' });
    const combined = `${r.stdout ?? ''}${r.stderr ?? ''}`;
    if (r.status !== 0 || !combined.includes('PACKED_IMPORT_OK')) {
      die(`tgz 内 index.js 无法真实加载 —— 装进 profile 后整个条目会失效：\n${combined.slice(0, 1200)}`);
    }
    log('  ✓ 包内 index.js 可加载，Config 能解析真实配置（含 maxBytes=null）');
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
}

if (dryRun) { log('\nDRY-RUN OK（未写远端）'); process.exit(0); }

// ---------- 4. 同步发布仓 + 提交 + tag + push ----------
if (!releasesOnly) {
  log('=== mirror to publish repo ===');
  // robocopy 用 0–7 表示成功（1 = 有文件被复制），>=8 才是失败。
  try {
    execFileSync('robocopy', [ROOT, REPO, '/MIR', '/XD', '.git', 'node_modules', '/NFL', '/NDL', '/NJH', '/NJS', '/NP'], { stdio: 'pipe', cwd: ROOT });
  } catch (e) {
    if (typeof e.status !== 'number' || e.status >= 8) die(`robocopy 失败 (exit ${e.status})`);
  }
  runInRepo(['add', '-A']);
  const status = runInRepo(['status', '--porcelain']);
  if (status) {
    runInRepo(['commit', '-m', `${tag}: ${version} release`]);
    log(`  committed`);
  } else log('  nothing to commit');

  log('=== tag ===');
  const existing = runInRepo(['tag', '-l', tag]);
  if (!existing) {
    runInRepo(['tag', '-a', tag, '-m', `${tag}`]);
    log(`  created ${tag}`);
  } else {
    const headOfTag = runInRepo(['rev-list', '-n', '1', tag]);
    const head = runInRepo(['rev-parse', 'HEAD']);
    if (headOfTag !== head) die(`tag ${tag} 已存在且不指向当前 HEAD（拒绝改写已发布 tag）`);
    log(`  ${tag} already at HEAD`);
  }

  log('=== push ===');
  runInRepo(['push', 'origin', 'main']);
  runInRepo(['push', 'origin', tag]);
  log('  pushed main + tag');
}

// ---------- 5. GitHub Release + .tgz 附件 ----------
log('=== github release ===');
const remoteTag = await ghApi(`git/ref/tags/${tag}`);
if (!remoteTag) die(`远端不存在 tag ${tag}，先推 tag`);
const notes = releaseNotes(changelogEn);
if (!notes) die('无法从 CHANGELOG 生成 Release 说明');
const title = releaseTitle(changelogEn);

let release = await ghApi(`releases/tags/${tag}`);
if (!release) {
  release = await ghApi('/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tag_name: tag, name: title, body: notes, draft: false, prerelease: false }),
  });
  log(`  release created: ${release.html_url}`);
} else {
  log(`  release exists: ${release.html_url}`);
  if (release.body !== notes || release.name !== title) {
    release = await ghApi(`/releases/${release.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title, body: notes }),
    });
    log(`  notes/title refreshed: ${title}`);
  }
}

const assets = release.assets || [];
if (assets.some((x) => x.name === tgzName)) {
  log(`  asset exists: ${tgzName}`);
} else {
  const bytes = readFileSync(finalTgz);
  const uploaded = await fetch(
    `https://uploads.github.com/repos/${OWNER_REPO}/releases/${release.id}/assets?name=${encodeURIComponent(tgzName)}`,
    { method: 'POST', headers: ghHeaders({ 'Content-Type': 'application/gzip', 'Content-Length': String(bytes.length) }), body: bytes },
  );
  if (!uploaded.ok) die(`附件上传失败 ${uploaded.status}: ${(await uploaded.text()).slice(0, 300)}`);
  log(`  asset uploaded: ${tgzName} (${bytes.length} B)`);
}

// ---------- 6. 终检 ----------
const verify = await ghApi(`releases/tags/${tag}`);
if (!verify.assets?.some((x) => x.name === tgzName)) die('终检失败：Release 附件缺失');
log(`\nDONE: https://github.com/${OWNER_REPO}/releases/tag/${tag}`);