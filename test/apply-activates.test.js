/**
 * apply() 真实执行门禁：用假的 Cordis ctx 把插件的注册过程整个跑一遍。
 *
 * 为什么需要它（延续 v0.2.2 / v0.2.3 / v0.2.5 的教训）：
 *  - `index.js` 的 `apply()` 是**安装时真正会执行的代码** —— 它创建 service、
 *    注册两个 Agent 工具、注册 UI 路由前缀。此前的测试从不碰它。
 *  - 任何在 `apply()` 里抛出的异常都会让整个插件条目「did not activate」，
 *    症状与 v0.2.2 完全一样：设置页直接消失。
 *  - 这里不是模拟 DSH 全部行为，只验证**注册动作本身能走通**：
 *    工具 id/参数 schema 合法、路由前缀正确、disposer 是函数。
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

function findRealSchemastery() {
  const c = [join(PLUGIN_NODE_MODULES, '@deepseek-ai', 'schemastery')];
  const profilesDir = join(homedir(), '.dsh', 'profiles');
  if (existsSync(profilesDir)) {
    for (const p of readdirSync(profilesDir)) {
      c.push(join(profilesDir, p, 'node_modules', '@deepseek-ai', 'schemastery'));
    }
  }
  return c.find((x) => existsSync(join(x, 'package.json'))) ?? null;
}

function ensureResolvable() {
  if (existsSync(join(PLUGIN_NODE_MODULES, '@deepseek-ai', 'schemastery', 'package.json'))) return;
  const found = findRealSchemastery();
  if (!found) throw new Error('找不到真实 @deepseek-ai/schemastery，无法执行 apply() 门禁');
  const host = found.slice(0, found.length - '/@deepseek-ai/schemastery'.length);
  if (!existsSync(PLUGIN_NODE_MODULES)) symlinkSync(host, PLUGIN_NODE_MODULES, 'junction');
}

async function loadPlugin() {
  ensureResolvable();
  return import(pathToFileURL(PLUGIN_INDEX).href);
}

/**
 * 造一个够用的假 Cordis ctx：记录所有注册动作，便于断言。
 */
function makeFakeCtx() {
  const log = { tools: [], effects: [], injected: [], routes: [], infos: [] };

  const ctx = {
    logger: { info: (...a) => log.infos.push(a), warn: () => {}, error: () => {} },

    // ctx.inject(names, cb)：立刻用假上下文执行 cb —— 等价于依赖已就位
    inject(names, cb) {
      log.injected.push(names);
      if (names.includes('credentials') && !names.includes('webServer')) {
        cb({ credentials: { resolve: async () => ({ value: 'x' }) } });
        return;
      }
      if (names.includes('webServer')) {
        cb({
          effect: (fn, name) => {
            log.effects.push(name);
            return fn();
          },
          webServer: {
            register: (def) => {
              log.routes.push(def);
              return () => {};
            },
          },
          settings: { update: async () => {} },
          credentials: { resolve: async () => ({ value: 'x' }) },
        });
      }
    },

    // ctx.effect(fn, name)：立刻执行 fn（注册工具即发生在这里）
    effect(fn, name) {
      log.effects.push(name);
      return fn();
    },

    tools: {
      register(tool) {
        log.tools.push(tool);
        return () => {};
      },
    },
  };

  return { ctx, log };
}

function realConfig(Config) {
  return Config({
    servers: [{
      name: 'toogel',
      host: '47.121.205.143',
      port: 22,
      user: 'root',
      keyPath: 'H:/odoo/key/odoo-backup',
      pinnedFingerprint: 'SHA256:oSJdaZyQHzXS8tLQq4kwlrR6J1KqAbJfC4x93WnOJFQ',
      extraPaths: [{ name: 'vault', path: '/root/Documents/Obsidian Vault', exclude: ['./.git'], maxBytes: null }],
    }],
    localBackupDir: 'K:/Backup/odoo',
    keepDays: 30,
    sshTimeoutMs: 30000,
    transferTimeoutMs: 3600000,
    allowUnencryptedPackage: false,
  });
}

test('APPLY-1 apply() 用真实 Config 能完整跑通，不抛异常', async () => {
  const mod = await loadPlugin();
  const { ctx, log } = makeFakeCtx();
  assert.doesNotThrow(() => mod.apply(ctx, realConfig(mod.Config)),
    'apply() 抛异常会让整个插件条目 did not activate（v0.2.2 的现场）');
  assert.ok(log.tools.length >= 2, `应注册至少 2 个 Agent 工具，实际 ${log.tools.length}`);
});

test('APPLY-2 两个工具 id 与参数 schema 合法', async () => {
  const mod = await loadPlugin();
  const { ctx, log } = makeFakeCtx();
  mod.apply(ctx, realConfig(mod.Config));

  const byId = Object.fromEntries(log.tools.map((t) => [t.name, t]));
  assert.ok(byId.odoo_backup, `缺少 odoo_backup 工具，实际有：${Object.keys(byId)}`);
  assert.ok(byId.odoo_restore, `缺少 odoo_restore 工具，实际有：${Object.keys(byId)}`);

  // output.schema 必须是 object —— v0.1.16 真机吃过 `"value" must be an object`
  for (const t of log.tools) {
    assert.equal(typeof t.execute, 'function', `${t.name} 缺 execute`);
    assert.equal(t.output?.schema?.type, 'object',
      `${t.name} 的 output.schema.type 必须是 object`);
  }
});

test('APPLY-3 UI 路由注册到 /odoo-backup 前缀，且 handler 是函数', async () => {
  const mod = await loadPlugin();
  const { ctx, log } = makeFakeCtx();
  mod.apply(ctx, realConfig(mod.Config));

  const route = log.routes.find((r) => r.path === '/odoo-backup');
  assert.ok(route, `应注册 /odoo-backup 路由，实际：${JSON.stringify(log.routes.map((r) => r.path))}`);
  assert.equal(route.kind, 'prefix');
  assert.equal(typeof route.handler, 'function');
});

test('APPLY-4 用空配置（默认值）也不会抛异常', async () => {
  const mod = await loadPlugin();
  const { ctx } = makeFakeCtx();
  const empty = mod.Config({});
  assert.doesNotThrow(() => mod.apply(ctx, empty),
    '首次安装时没有任何服务器，apply() 必须能起来');
});

test('APPLY-5 注册的工具能被真实调用（listServers 走通整个 execute 链路）', async () => {
  const mod = await loadPlugin();
  const { ctx, log } = makeFakeCtx();
  mod.apply(ctx, realConfig(mod.Config));

  const tool = log.tools.find((t) => t.name === 'odoo_backup');
  const out = await tool.execute({ action: 'listServers' });
  assert.equal(out.ok, true);
  assert.equal(out.servers.length, 1, '应能看到配置里的 toogel');
  assert.equal(out.servers[0].extraPaths, 1, 'extraPaths 条数必须透出');
  // 敏感字段不外泄
  assert.equal(out.servers[0].keyPath, undefined);
  assert.equal(out.servers[0].pinnedFingerprint, undefined);
});
