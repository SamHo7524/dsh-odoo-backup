/**
 * 真实加载门禁：**必须真的 import index.js 并用真实数据跑一遍 Config**。
 *
 * 为什么需要这个文件（血的教训）：
 *  - v0.2.2 装了但整个条目没激活，报 `TypeError: z.number(...).nullable is not a function`。
 *    742 个单测全绿，因为**没有任何测试 import 过 index.js** —— 测试都在做源码正则匹配，
 *    真正会崩的那一行从未被执行。
 *  - 这类错误的代价是：发版 → 装不上 → 用户设置页整个消失 → 再来一个 hotfix 版本。
 *
 * 本文件的原则：
 *  1) **绝不 skip**。缺依赖就尝试自动修复，修不了就报错并给出可操作指令。
 *     「静默跳过」正是这个 bug 得以发货的原因。
 *  2) **不只 import，还要把 Config 真的跑一遍**。能加载 ≠ schema 能接受真实数据。
 *  3) 覆盖真实配置形态：maxBytes 为 null（最常见）、为数字、字段全缺省。
 *  4) schemastery 必须用**真实的**库，不能用 stub —— 否则「不支持的方法」这类错误抓不到。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readdirSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = join(HERE, '..');
const PLUGIN_INDEX = join(PLUGIN_ROOT, 'index.js');
const PLUGIN_NODE_MODULES = join(PLUGIN_ROOT, 'node_modules');

/**
 * 尝试找到一个真实可用的 `@deepseek-ai/schemastery` 安装位置。
 *
 * 插件把 schemastery 声明为 peerDependency，开发树默认没有 node_modules；
 * 而 DSH 的 profile 里一定有一份（宿主运行插件时用的就是它）。
 */
function findRealSchemastery() {
  const candidates = [];

  // 1) 插件自己的 node_modules（若已 install 或已挂载）
  candidates.push(join(PLUGIN_NODE_MODULES, '@deepseek-ai', 'schemastery'));

  // 2) 本机 DSH 的各个 profile —— 宿主运行插件时用的就是这些
  const profilesDir = join(homedir(), '.dsh', 'profiles');
  if (existsSync(profilesDir)) {
    for (const p of readdirSync(profilesDir)) {
      candidates.push(join(profilesDir, p, 'node_modules', '@deepseek-ai', 'schemastery'));
    }
  }

  return candidates.find((c) => existsSync(join(c, 'package.json'))) ?? null;
}

/**
 * 让 `import(PLUGIN_INDEX)` 能解析到 schemastery。
 *
 * 做法：把找到的 profile `node_modules` 以目录联接挂到插件根目录下。
 * 这是开发期的一次性便利，`node_modules/` 本来就在 .gitignore 里，不会污染发布物。
 */
function ensureResolvableDependency() {
  const direct = join(PLUGIN_NODE_MODULES, '@deepseek-ai', 'schemastery');
  if (existsSync(join(direct, 'package.json'))) return { ok: true, how: 'plugin node_modules 已就绪' };

  const found = findRealSchemastery();
  if (!found) return { ok: false };

  // found = <...>/node_modules/@deepseek-ai/schemastery
  const hostNodeModules = found.slice(0, found.length - '/@deepseek-ai/schemastery'.length);

  try {
    if (!existsSync(PLUGIN_NODE_MODULES)) {
      symlinkSync(hostNodeModules, PLUGIN_NODE_MODULES, 'junction');
      return { ok: true, how: `已挂载目录联接 -> ${hostNodeModules}` };
    }
    return { ok: false, hostNodeModules };
  } catch (err) {
    return { ok: false, hostNodeModules, error: err.message };
  }
}

/**
 * 加载插件入口。失败时不 skip，抛出可操作的错误。
 */
async function loadPlugin() {
  try {
    return await import(pathToFileURL(PLUGIN_INDEX).href);
  } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes('schemastery')) {
      const fix = ensureResolvableDependency();
      if (fix.ok) {
        // 挂载成功，重试一次
        return await import(pathToFileURL(PLUGIN_INDEX).href);
      }
      throw new Error(
        `无法加载插件入口 index.js：${err.message}\n`
        + '这是真实加载门禁，**不允许跳过**。修复方式（任选其一）：\n'
        + '  1) 在 dsh-odoo-backup 目录执行 pnpm install；\n'
        + '  2) 手动挂载 DSH profile 的依赖树（Windows）：\n'
        + '     New-Item -ItemType Junction -Path node_modules -Target C:\\Users\\<you>\\.dsh\\profiles\\desktop\\node_modules\n'
        + `自动修复也未成功：${JSON.stringify(fix)}`,
      );
    }
    throw err;
  }
}

test('LOAD-1 index.js 能被真实 import，且导出契约齐备', async () => {
  const mod = await loadPlugin();
  assert.equal(mod.name, 'odoo-backup', '运行时 entry id 必须保持 odoo-backup（改了配置会丢）');
  assert.ok(Array.isArray(mod.inject), 'inject 必须是数组');
  assert.equal(typeof mod.apply, 'function', 'apply 必须是函数');
  assert.equal(typeof mod.Config, 'function', 'Config 必须是 schemastery schema（可调用）');
  assert.equal(typeof mod.unwrapVolatile, 'function');
});

test('LOAD-2 Config 能接受真实服务器配置（含 extraPaths / maxBytes=null）', async () => {
  const { Config, unwrapVolatile } = await loadPlugin();
  // 与 cordis.patch.yml 里 toogel 的真实形态一致
  const parsed = Config({
    servers: [{
      name: 'toogel',
      host: '47.121.205.143',
      port: 22,
      user: 'root',
      keyPath: 'H:/odoo/key/odoo-backup',
      pinnedFingerprint: 'SHA256:oSJdaZyQHzXS8tLQq4kwlrR6J1KqAbJfC4x93WnOJFQ',
      extraPaths: [{
        name: 'vault',
        path: '/root/Documents/Obsidian Vault',
        exclude: ['./.git'],
        maxBytes: null,
      }],
    }],
  });

  // servers 是 volatile 字段：真实消费者（index.js 的 serversRef / tools.js 的 findServer）
  // 都要先 unwrapVolatile 再用，测试必须按同样方式访问。
  const servers = unwrapVolatile(parsed.servers);
  assert.equal(servers.length, 1);
  const s = servers[0];
  assert.equal(s.name, 'toogel');
  assert.equal(s.extraPaths.length, 1, 'extraPaths 必须被 schema 接住，不能被静默丢弃');
  assert.equal(s.extraPaths[0].name, 'vault');
  assert.equal(s.extraPaths[0].path, '/root/Documents/Obsidian Vault');
  assert.deepEqual(s.extraPaths[0].exclude, ['./.git']);
  assert.equal(s.extraPaths[0].maxBytes, null, 'maxBytes=null 必须保留为 null');
});

test('LOAD-3 Config 缺省时 extraPaths 默认为空数组', async () => {
  const { Config, unwrapVolatile } = await loadPlugin();
  const parsed = Config({ servers: [{ name: 'x', host: 'h' }] });
  const servers = unwrapVolatile(parsed.servers);
  assert.deepEqual(servers[0].extraPaths, []);
});

test('LOAD-4 Config 对 maxBytes=数字 正常保留', async () => {
  const { Config, unwrapVolatile } = await loadPlugin();
  const parsed = Config({
    servers: [{
      name: 'x',
      host: 'h',
      extraPaths: [{ name: 'a', path: '/p', maxBytes: 1024 }],
    }],
  });
  const servers = unwrapVolatile(parsed.servers);
  assert.equal(servers[0].extraPaths[0].maxBytes, 1024);
});

test('LOAD-5 Config 整体缺省时 servers 为空数组（不能崩）', async () => {
  const { Config, unwrapVolatile } = await loadPlugin();
  const parsed = Config({});
  // servers 是 volatile 字段，默认值会被包成 {get()}；必须解包后比较
  // （这正是 v0.1.15 `list.find is not a function` 的成因，测试里也要按真实用法解包）。
  assert.deepEqual([...unwrapVolatile(parsed.servers)], []);
});

test('LOAD-6 真实配置形态经 unwrap 后 extraPaths 完整（对齐 cordis.patch.yml）', async () => {
  const { Config, unwrapVolatile } = await loadPlugin();
  const parsed = Config({
    servers: [{
      name: 'toogel',
      host: '47.121.205.143',
      extraPaths: [{ name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'], maxBytes: null }],
    }],
  });
  const servers = unwrapVolatile(parsed.servers);
  assert.equal(servers.length, 1);
  assert.equal(servers[0].extraPaths.length, 1);
  assert.equal(servers[0].extraPaths[0].maxBytes, null);
});
