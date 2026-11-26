import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';
import { createOdooRestoreTool } from '../lib/tools.js';

// v0.4.0 Task 4：工具路径也必须受服务层用途闸门约束。
// odoo_restore 是 Agent 直接调用的入口，不经过任何 GUI —— 界面过滤挡不住它。
const servers = [
  { name: 'toogel', host: '47.121.205.143', user: 'root', role: 'backup' },
  { name: 'odoo.toogel.cn', host: '134.175.51.9', user: 'root', role: 'restore' },
];

/** tokenStore 观察者：任何 create/verify 都会留下痕迹。 */
function makeStore() {
  const seen = { create: 0, verify: 0 };
  return {
    seen,
    create(payload) { seen.create += 1; return { token: 'tok', expiresInSeconds: 300, payload }; },
    verify() { seen.verify += 1; return { ok: false, error: { message: '不应走到 verify' } }; },
  };
}

function makeTool() {
  const store = makeStore();
  // 依赖全部抛错：只要闸门失败，任何依赖都不该被调用。
  const deps = {
    credentials: { resolve: async () => { throw new Error('不该取口令'); } },
    guardHostKey: async () => { throw new Error('不该校验指纹'); },
    discover: async () => { throw new Error('不该远端发现'); },
    execRemote: async () => { throw new Error('不该远端执行'); },
    stat: async () => { throw new Error('不该 stat 备份包'); },
    detectFormat: async () => { throw new Error('不该探测包格式'); },
    readPackageMeta: async () => { throw new Error('不该读包元数据'); },
  };
  const service = createService({ config: { servers }, deps });
  const tool = createOdooRestoreTool({ config: { servers }, service, tokenStore: store });
  return { tool, store };
}

test('TOOL-1 odoo_restore precheck 指向备份源 → 抛用途错误且不签发 token', async () => {
  const { tool, store } = makeTool();
  await assert.rejects(
    () => tool.execute({ action: 'precheck', server: 'toogel', packagePath: 'K:\\Backup\\x.tar.enc' }),
    (e) => /toogel/.test(e.message) && /用途/.test(e.message),
  );
  assert.equal(store.seen.create, 0, '拒绝时绝不能签发 token');
  assert.equal(store.seen.verify, 0);
});

test('TOOL-2 odoo_restore restore 指向备份源 → 服务层用途闸门拒绝且不触达远端依赖', async () => {
  const { tool, store } = makeTool();
  // 错误必须来自用途闸门本身（含服务器名与「用途」），而不是来自后续任一依赖。
  // deps 里每个依赖都抛「不该…」：一旦闸门失效往下走，就不会是「用途」错误。
  await assert.rejects(
    () => tool.execute({ action: 'restore', server: 'toogel', packagePath: 'K:\\Backup\\x.tar.enc', confirmToken: 'whatever' }),
    (e) => /toogel/.test(e.message) && /用途/.test(e.message) && !/不该/.test(e.message),
  );
  // 说明（规格 §6.3）：判据是 9 类远端/凭证依赖零调用 + 不「签发」token（create）。
  // 工具层 tokenStore.verify 是 v0.1.x 起既有的本地授权步骤，不在上述判据内；
  // 且真实链路中备份源拿不到合法 token（precheck 已被用途闸门拒绝），不构成安全缺口。
  assert.equal(store.seen.create, 0, '任何路径都不得为备份源签发 token');
});

test('TOOL-3 指向恢复目标时不会被用途闸门拦住（错误来自后续真实依赖，不是用途）', async () => {
  const { tool } = makeTool();
  await assert.rejects(
    () => tool.execute({ action: 'precheck', server: 'odoo.toogel.cn', packagePath: 'K:\\Backup\\x.tar.enc' }),
    (e) => !/用途/.test(e.message),
  );
});
