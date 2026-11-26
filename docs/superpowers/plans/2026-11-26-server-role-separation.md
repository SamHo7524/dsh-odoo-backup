# 服务器用途隔离（备份源 / 恢复目标）实施计划

> **给执行者**：本计划是逐任务的施工图。每个 Task 先写失败测试（RED）、再最小实现（GREEN）、再做变异验证、最后记一次测试数。
> 步骤用 `- [ ]` 勾选跟踪。不要跳步，不要合并 Task。

**Goal（目标）**：给备份插件加一个「服务器用途」维度（`backup` / `restore` 互斥），让恢复操作在服务层就被拒绝，而不是靠界面隐藏按钮。

**Architecture（架构）**：一个纯函数模块 `lib/server-role.js` 提供角色语义；`lib/service.js` 的五个破坏性入口在**取得配置后、任何副作用之前**调用断言；`client.js` 内联同语义实现用于分类渲染（浏览器包不能 import lib，沿用 `isHostname`/`normalizeRestorePath` 的既有内联 + 防漂移断言手法）；`index.js` 在 `/save-servers` 写入前严格校验。

**Tech Stack**：Node ESM、`node:test`、schemastery（`z`）、React（`react-dom/server` 做真渲染断言）、PowerShell 驱动测试。

**Spec**：[docs/superpowers/specs/2026-11-26-server-role-separation-design.md](../specs/2026-11-26-server-role-separation-design.md)
（spec 与本计划同行；两者冲突时以 spec 为准，并按 spec §11 追加变更记录）

---

## 0. 结论先行：这次要做成什么

一台服务器只能是**备份源**或**恢复目标**之一。备份页只列备份源，恢复页（含中立化卡片）只列恢复目标。**任何**破坏性入口——界面、Agent 工具、以后新增的调用方——在触达远端之前按用途拒绝。

范围边界：

- **做**：角色纯函数、配置字段与保存校验、服务层五处闸门、界面分类与切换确认、配置迁移、测试与变异、发版。
- **不做**：服务器删除二次确认（独立小 bugfix）、恢复前手输库名（P2，非发布判据）、WAF、Phase 2、attendance `depsLocks`（已批准但延后）。

## 1. 文件结构（改动地图）

| 文件 | 动作 | 责任 |
|---|---|---|
| `lib/server-role.js` | 新增 | 角色语义唯一权威：`normalizeServerRole` / `roleOf` / `canBackup` / `canRestore` / `assertBackupServer` / `assertRestoreTarget` / `partitionServers` |
| `test/server-role.test.js` | 新增 | 纯函数语义（含「不改入参」） |
| `index.js` | 改 | Config schema 加 `role`；`/save-servers` 写入前校验（非法拒绝保存） |
| `test/server-role-config.test.js` | 新增 | schema 落值 + 保存校验行为（真调 route 处理函数） |
| `lib/service.js` | 改 | 两个本地助手 `requireBackupSource` / `requireRestoreTarget`；五个入口首行接线 |
| `test/server-role-gate.test.js` | 新增 | 服务层闸门 + 九类依赖调用计数为 0 |
| `test/server-role-tool.test.js` | 新增 | `odoo_restore` 工具路径拒绝且不签发 token |
| `client.js` | 改 | 内联 `roleOf`/`partitionServers`；服务器页徽章+用途选择+切换确认；备份页/恢复页/中立化卡片过滤；空态；`initialTab` 测试缝 |
| `test/client-role-ui.test.js` | 新增 | 界面源码契约 + 与 `lib/server-role.js` 的规则防漂移断言 |
| `test/server-role-render.test.js` | 新增 | react-dom 真渲染：恢复页不含备份源、备份页不含恢复目标、中立化卡片只含恢复目标 |
| `C:\Users\Ho\.dsh\profiles\desktop\cordis.patch.yml` | 改 | 迁移：`odoo.toogel.cn` → `role: restore`；`toogel` → 显式 `role: backup` |
| `package.json` / 双 README / 双 CHANGELOG | 改 | `0.3.2` → `0.4.0`、测试数、六个说明章节 |

## 2. 数据契约（跨 Task 的精确签名）

```js
// lib/server-role.js
export const SERVER_ROLES = ['backup', 'restore'];
export const ROLE_LABELS = { backup: '备份服务器', restore: '恢复目标' };
export function normalizeServerRole(value);   // → { ok:true, role:'backup'|'restore' } | { ok:false, reason:string }
export function roleOf(server);               // → 'backup' | 'restore'
export function canBackup(server);            // → boolean
export function canRestore(server);           // → boolean
export function assertBackupServer(server);   // → server（合法）| 抛 Error（消息含 name 与「用途」）
export function assertRestoreTarget(server);  // → server（合法）| 抛 Error（消息含 name 与「用途」）
export function partitionServers(raw);        // → { backup: [], restore: [] }（顺序保持，非数组→两个空数组）

// lib/service.js 内部（不导出）
function requireBackupSource(name);           // → server 配置对象（同步、纯本地）
function requireRestoreTarget(name);          // → server 配置对象（同步、纯本地）
```

## 3. 全局约束

- **生产 `47.121.205.143`（toogel）全程只读**：本轮允许的动作仅 `ssh` 只读查询与 `odoo_backup action=test/discover/listServers` 之类只读调用；**不做恢复、不改生产配置、不重启服务**。
- 测试机 `134.175.51.9`（`odoo.toogel.cn`）允许改配置字段（`role`）与本地临时文件；不做破坏性恢复。
- 全量测试必须串行：`& $node --test --test-concurrency=1 @files`（并行会因固定状态目录互踩）。
- `node` 路径：`K:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe`。
- 工作区不是 git 仓库：不建 commit/tag；可追溯性靠发布脚本 + SHA256。
- **基线测试数 1129**（v0.3.2）。任何 Task 结束时跑全量，数字不得低于基线 + 本计划新增数。
- 变异验证的判定口径（沿用 v0.3.1 教训）：**输出里有 `ℹ tests N` 且 `ℹ fail > 0` 才算 KILLED**；连 `ℹ tests` 都没有才是 CRASHY（加载期错误）。把 `ERR_ASSERTION` 当崩溃是错的。

---

## 4. 任务分解

### Task 1 — `lib/server-role.js` 纯函数层

**Files**

- 新增 `lib/server-role.js`
- 新增 `test/server-role.test.js`

**Interfaces（本 Task 产出）**：见 §2 全部导出。

- [ ] **Step 1（3 min）写失败测试**

`test/server-role.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert';
import {
  SERVER_ROLES, ROLE_LABELS,
  normalizeServerRole, roleOf, canBackup, canRestore,
  assertBackupServer, assertRestoreTarget, partitionServers,
} from '../lib/server-role.js';

// ---------------- 写入时严格校验 ----------------

test('SR-1 缺失/空串 → backup（安全侧默认）', () => {
  for (const v of [undefined, null, '']) {
    assert.deepEqual(normalizeServerRole(v), { ok: true, role: 'backup' });
  }
});

test('SR-2 两个合法值原样通过', () => {
  assert.deepEqual(normalizeServerRole('backup'), { ok: true, role: 'backup' });
  assert.deepEqual(normalizeServerRole('restore'), { ok: true, role: 'restore' });
  assert.deepEqual(normalizeServerRole('  restore  '), { ok: true, role: 'restore' });
});

test('SR-3 拼错/大小写/非字符串 → 拒绝保存（不是静默降级）', () => {
  for (const v of ['RESTORE', 'Restore', 'restroe', 'prod', 1, true, {}, []]) {
    const r = normalizeServerRole(v);
    assert.equal(r.ok, false, `应拒绝：${JSON.stringify(v)}`);
    assert.match(r.reason, /backup|restore/);
  }
});

// ---------------- 运行时判定（容错方向） ----------------

test('SR-4 roleOf 只认精确 restore，其余全按 backup', () => {
  assert.equal(roleOf({ role: 'restore' }), 'restore');
  assert.equal(roleOf({ role: 'backup' }), 'backup');
  for (const v of [undefined, null, '', 'RESTORE', 'Restore', 'restroe', 1, true, {}]) {
    assert.equal(roleOf({ role: v }), 'backup', `必须落到安全侧：${JSON.stringify(v)}`);
  }
  assert.equal(roleOf(undefined), 'backup');
  assert.equal(roleOf(null), 'backup');
});

test('SR-5 roleOf 不修改入参（冻结对象不抛错，前后深相等）', () => {
  const s = Object.freeze({ name: 'toogel', role: 'restore', extra: Object.freeze({ a: 1 }) });
  const before = JSON.stringify(s);
  assert.equal(roleOf(s), 'restore');
  assert.equal(JSON.stringify(s), before);
  assert.equal(roleOf(s), 'restore', '第二次调用不能因为「自动修复」而改变结果');
});

test('SR-6 canBackup / canRestore 互斥', () => {
  assert.equal(canBackup({ role: 'backup' }), true);
  assert.equal(canRestore({ role: 'backup' }), false);
  assert.equal(canBackup({ role: 'restore' }), false);
  assert.equal(canRestore({ role: 'restore' }), true);
});

// ---------------- 断言文案 ----------------

test('SR-7 对恢复目标备份 → 抛错，含服务器名与「用途」', () => {
  assert.throws(
    () => assertBackupServer({ name: 'odoo.toogel.cn', role: 'restore' }),
    (e) => /odoo\.toogel\.cn/.test(e.message) && /用途/.test(e.message) && /快照/.test(e.message),
  );
});

test('SR-8 对备份源恢复 → 抛错，含服务器名、「用途」与破坏性说明', () => {
  assert.throws(
    () => assertRestoreTarget({ name: 'toogel', role: 'backup' }),
    (e) => /toogel/.test(e.message) && /用途/.test(e.message) && /RENAME|覆盖/.test(e.message),
  );
});

test('SR-9 合法用途返回原对象（便于链式取配置）', () => {
  const a = { name: 'a', role: 'backup' };
  assert.equal(assertBackupServer(a), a);
  const b = { name: 'b', role: 'restore' };
  assert.equal(assertRestoreTarget(b), b);
});

test('SR-10 未命名服务器也能给出可读文案', () => {
  assert.throws(() => assertRestoreTarget({}), /未命名服务器/);
});

// ---------------- 分类 ----------------

test('SR-11 partitionServers 保持顺序、两类不交叉', () => {
  const list = [
    { name: 'p1', role: 'backup' },
    { name: 'r1', role: 'restore' },
    { name: 'n1' },
    { name: 'r2', role: 'restore' },
    { name: 'p2', role: 'backup' },
  ];
  const { backup, restore } = partitionServers(list);
  assert.deepEqual(backup.map((s) => s.name), ['p1', 'n1', 'p2']);
  assert.deepEqual(restore.map((s) => s.name), ['r1', 'r2']);
});

test('SR-12 partitionServers 对脏输入不崩', () => {
  for (const bad of [undefined, null, 'x', 1, {}]) {
    assert.deepEqual(partitionServers(bad), { backup: [], restore: [] });
  }
});

test('SR-13 常量自洽', () => {
  assert.deepEqual(SERVER_ROLES, ['backup', 'restore']);
  assert.deepEqual(Object.keys(ROLE_LABELS).sort(), ['backup', 'restore']);
});
```

- [ ] **Step 2（2 min）跑测试确认 RED**

```powershell
$node='K:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
& $node --test --test-concurrency=1 test\server-role.test.js
```
预期：`Cannot find module '../lib/server-role.js'`。

- [ ] **Step 3（5 min）写实现**

`lib/server-role.js`：

```js
/**
 * v0.4.0 — 服务器用途（备份源 / 恢复目标）互斥分类。
 *
 * 为什么单独一个模块：这条规则要被三处用到（服务层闸门、Host 保存校验、GUI 过滤），
 * 而它是纯数据判断——没有 IO、没有配置、没有远端。塞进 service.js 则 GUI 拿不到；
 * 塞进 client.js 则服务层拿不到（Agent 工具不经过界面）。
 *
 * 两个函数的职责必须分开（spec §5）：
 *  - normalizeServerRole：配置**写入时**严格校验，拼错就拒绝保存，让错误在入口暴露。
 *  - roleOf：**运行时**判定，只认精确 'restore'，其余一律 'backup'，
 *    且不修改入参、不自动修复、不持久化。容错方向是安全侧——
 *    配置坏了的结果是「恢复页少一台机器」，而不是「生产出现在恢复页」。
 */

export const SERVER_ROLES = ['backup', 'restore'];

export const ROLE_LABELS = {
  backup: '备份服务器',
  restore: '恢复目标',
};

function displayName(server) {
  const n = typeof server?.name === 'string' ? server.name.trim() : '';
  return n || '(未命名服务器)';
}

/** 配置写入时严格校验：缺失 → backup；非法 → 拒绝保存。 */
export function normalizeServerRole(value) {
  if (value === undefined || value === null || value === '') {
    return { ok: true, role: 'backup' };
  }
  if (typeof value === 'string') {
    const v = value.trim();
    if (v === 'backup' || v === 'restore') return { ok: true, role: v };
  }
  return {
    ok: false,
    reason: '服务器用途只能是 backup（备份服务器）或 restore（恢复目标），'
      + `收到：${JSON.stringify(value)}`,
  };
}

/** 运行时判定：纯函数，只认精确 'restore'。 */
export function roleOf(server) {
  return server?.role === 'restore' ? 'restore' : 'backup';
}

export function canBackup(server) {
  return roleOf(server) === 'backup';
}

export function canRestore(server) {
  return roleOf(server) === 'restore';
}

/** 破坏性入口：备份源校验。 */
export function assertBackupServer(server) {
  if (canBackup(server)) return server;
  throw new Error(
    `服务器「${displayName(server)}」的用途是「${ROLE_LABELS.restore}」，不能作为备份源。`
    + '恢复目标的内容来自备份包，对它备份会产生一份「看起来像生产、其实不是」的快照。'
    + `请到「服务器」页把用途改为「${ROLE_LABELS.backup}」。`,
  );
}

/** 破坏性入口：恢复目标校验。 */
export function assertRestoreTarget(server) {
  if (canRestore(server)) return server;
  throw new Error(
    `服务器「${displayName(server)}」的用途是「${ROLE_LABELS.backup}」，不能作为恢复目标。`
    + '恢复会执行 ALTER DATABASE ... RENAME 覆盖目标库并替换 filestore，'
    + `因此只允许用途为「${ROLE_LABELS.restore}」的服务器执行。`
    + `如果这台机器确实是演练机，请到「服务器」页把用途改为「${ROLE_LABELS.restore}」`
    + '（该改动需要输入服务器名确认）。',
  );
}

/** 界面分类：保持原顺序，对脏输入返回两个空数组。 */
export function partitionServers(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const backup = [];
  const restore = [];
  for (const s of list) (roleOf(s) === 'restore' ? restore : backup).push(s);
  return { backup, restore };
}
```

- [ ] **Step 4（2 min）跑测试确认 GREEN**

```powershell
& $node --test --test-concurrency=1 test\server-role.test.js
```
预期：`# pass 13`、`# fail 0`。

- [ ] **Step 5（3 min）变异 M-SR1：`roleOf` 默认值改成 `restore`**

把 `server?.role === 'restore' ? 'restore' : 'backup'` 改成 `server?.role === 'backup' ? 'backup' : 'restore'` 再跑 Step 4：
预期 SR-4/SR-6/SR-11 变红（fail>0）。**恢复原样**后再跑一次确认全绿。

---

### Task 2 — 配置字段与写入校验

**Files**

- 改 `index.js`（schema `role`；`/save-servers` 校验）
- 新增 `test/server-role-config.test.js`

**Interfaces**

- 消费 Task 1 的 `normalizeServerRole`。
- 产出：`GET /servers` 与 `/save-servers` 保存的 server 对象都带 `role`（缺失时落 `backup`）。

- [ ] **Step 1（3 min）先验证 schemastery 是否支持 `z.const`**

```powershell
& $node -e "import('schemastery').then(m=>{const z=m.default; try{const S=z.object({role:z.union([z.const('backup'),z.const('restore')]).default('backup')}); console.log('CONST_OK', JSON.stringify(S({}))); console.log('BAD', JSON.stringify(S({role:'nope'})));}catch(e){console.log('CONST_FAIL', e.message)}})"
```
- 输出含 `CONST_OK {"role":"backup"}` → 用 `z.const` 方案（Step 3 的 A 版）。
- 输出 `CONST_FAIL` → 用 **B 版**：`role: z.string().default('backup').description(...)`，并在注释里写明「schema 不做枚举限制，枚举由 `/save-servers` 的 `normalizeServerRole` 与运行时 `roleOf` 双保险」。

- [ ] **Step 2（3 min）写失败测试**

`test/server-role-config.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('SRC-1 schema 里有 role 字段且默认 backup', () => {
  assert.match(src, /role:\s*z\b/);
  assert.match(src, /\.default\('backup'\)/);
});

test('SRC-2 /save-servers 在写入前调用 normalizeServerRole', () => {
  const iSave = src.indexOf("route === '/save-servers'");
  assert.ok(iSave > 0, '必须存在 /save-servers 路由');
  const iUpdate = src.indexOf('settings.update(entryId, { servers', iSave);
  assert.ok(iUpdate > iSave, '必须能定位写入点');
  const block = src.slice(iSave, iUpdate);
  assert.match(block, /normalizeServerRole/, '写入前必须校验用途');
  assert.match(block, /roleCheck\.ok/, '必须按校验结果拒绝');
});

test('SRC-3 /save-servers 归一化后的 role 一并写入（不是丢弃）', () => {
  const iSave = src.indexOf("route === '/save-servers'");
  const iUpdate = src.indexOf('settings.update(entryId, { servers', iSave);
  const block = src.slice(iSave, iUpdate);
  assert.match(block, /role:\s*roleCheck\.role/, '必须把归一化后的 role 写回条目');
});
```

- [ ] **Step 3（2 min）跑测试确认 RED**

```powershell
& $node --test --test-concurrency=1 test\server-role-config.test.js
```
预期：SRC-1 失败（schema 还没有 role）。

- [ ] **Step 4（5 min）改 `index.js`**

(a) schema（`servers` 定义内，`depsLocks` 之后加；A 版）：

```js
          // v0.4.0：服务器用途（互斥两类）。默认值方向 = 安全侧：
          // 老配置缺失 role 时按「备份服务器」处理，绝不默认进恢复列表。
          role: z
            .union([z.const('backup'), z.const('restore')])
            .default('backup')
            .description(
              '服务器用途：backup=备份服务器（默认，生产服务器）／restore=恢复目标（会被覆盖）。'
              + '两类互斥：备份源绝不出现在恢复页，恢复目标绝不出现在备份页',
            ),
```

(b) `/save-servers`（替换现有 for 循环与写入行）：

```js
      const servers = Array.isArray(body.servers) ? body.servers : null;
      if (!servers) throw new Error('缺少 servers 数组');
      // v0.4.0：用途在写入时严格校验（拼错就拒绝保存，而不是静默降级），
      // 并把归一化结果写回条目——否则「缺失 role」会一直以缺字段形态存在，
      // 只能靠 roleOf 兜底，用户看不出这台机器到底被当成什么。
      const normalized = [];
      for (const s of servers) {
        if (!s || typeof s.name !== 'string' || !s.name.trim()) {
          throw new Error('每个服务器都需要非空 name');
        }
        const name = s.name.trim();
        const roleCheck = normalizeServerRole(s.role);
        if (!roleCheck.ok) {
          throw new Error(`服务器「${name}」的用途非法：${roleCheck.reason}`);
        }
        normalized.push({ ...s, name, role: roleCheck.role });
      }
      if (!settings || typeof settings.update !== 'function') {
        throw new Error('Host 设置服务不可用，无法保存配置');
      }
      await settings.update(entryId, { servers: normalized });
      return send(200, { ok: true, servers: normalized });
```

(c) import 行追加：

```js
import { normalizeServerRole } from './lib/server-role.js';
```

- [ ] **Step 5（2 min）跑测试确认 GREEN**

```powershell
& $node --test --test-concurrency=1 test\server-role-config.test.js
& $node --test --test-concurrency=1 test\config-contract.test.js
```
预期：两个文件全绿（`config-contract` 是既有契约，确认没被 schema 改动打破）。

---

### Task 3 — 服务层五处闸门

**Files**

- 改 `lib/service.js`
- 新增 `test/server-role-gate.test.js`

**Interfaces**

- 消费 Task 1 的 `assertBackupServer` / `assertRestoreTarget`。
- 产出（内部）：`requireBackupSource(name)` / `requireRestoreTarget(name)`，同步、纯本地。

- [ ] **Step 1（4 min）写失败测试**

`test/server-role-gate.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';

const ZERO_KEYS = [
  'credentials', 'guardHostKey', 'discover', 'execRemote',
  'scpUpload', 'scpDownload', 'stat', 'detectFormat', 'readPackageMeta',
];

/** 每个依赖都被计数；任何非零即证明闸门没站在最前面。 */
function makeCounters() {
  const n = Object.fromEntries(ZERO_KEYS.map((k) => [k, 0]));
  const deps = {
    credentials: { resolve: async () => { n.credentials += 1; return 'passphrase-20-chars!!'; } },
    guardHostKey: async () => { n.guardHostKey += 1; return { ok: true }; },
    discover: async () => {
      n.discover += 1;
      return { instances: [{ dbName: 'toogel', odooContainer: 'oc', pgContainer: 'pc', pgSuperUser: 'pgsql', dataPath: '/d', addonsPath: '/a' }] };
    },
    execRemote: async () => { n.execRemote += 1; return { stdout: '', stderr: '', code: 0 }; },
    scpUpload: async () => { n.scpUpload += 1; },
    scpDownload: async () => { n.scpDownload += 1; },
    stat: async () => { n.stat += 1; return { size: 10 }; },
    detectFormat: async () => { n.detectFormat += 1; return 'encrypted'; },
    readPackageMeta: async () => { n.readPackageMeta += 1; return { ok: true, sourceDbName: 'tg-odoo' }; },
    runBackup: async () => { throw new Error('不该跑到 runBackup'); },
    runRestore: async () => { throw new Error('不该跑到 runRestore'); },
  };
  return { n, deps };
}

function makeService(servers) {
  const { n, deps } = makeCounters();
  const svc = createService({ config: { servers }, deps });
  return { svc, n };
}

const PROD = { name: 'toogel', host: '47.121.205.143', user: 'root', role: 'backup' };
const DRILL = { name: 'odoo.toogel.cn', host: '134.175.51.9', user: 'root', role: 'restore' };

function assertAllZero(n, label) {
  for (const k of ZERO_KEYS) {
    assert.equal(n[k], 0, `${label}：${k} 调用次数必须为 0，实际 ${n[k]}`);
  }
}

const PKG = 'K:\\Backup\\odoo\\x.tar.enc';

test('GATE-1 对备份源执行 restore → 拒绝且九类依赖调用为 0', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(
    () => svc.restore('toogel', undefined, PKG, {}),
    (e) => /toogel/.test(e.message) && /用途/.test(e.message),
  );
  assertAllZero(n, 'restore');
});

test('GATE-2 对备份源执行 inspectRestore → 拒绝且零调用', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.inspectRestore('toogel', PKG), /用途/);
  assertAllZero(n, 'inspectRestore');
});

test('GATE-3 对备份源执行 neutralizeStatus → 拒绝且零调用', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.neutralizeStatus('toogel'), /用途/);
  assertAllZero(n, 'neutralizeStatus');
});

test('GATE-4 对备份源执行 applyNeutralize(release) → 拒绝且零调用', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.applyNeutralize('toogel', 'release'), /用途/);
  assertAllZero(n, 'applyNeutralize/release');
});

test('GATE-5 applyNeutralize(keep) 同样被拒（不留「keep 成功 / release 被拒」割裂）', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.applyNeutralize('toogel', 'keep'), /用途/);
  assertAllZero(n, 'applyNeutralize/keep');
});

test('GATE-6 keep 对不存在的服务器名也抛错（行为收紧）', async () => {
  const { svc } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.applyNeutralize('no-such-server', 'keep'), /未找到服务器/);
});

test('GATE-7 对恢复目标执行 backup → 拒绝且口令校验为零次', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  await assert.rejects(() => svc.backup('odoo.toogel.cn'), /用途/);
  assertAllZero(n, 'backup');
});

test('GATE-8 对备份源执行 backup 不再被用途闸门拦住（生产备份不受影响）', async () => {
  const { svc, n } = makeService([PROD, DRILL]);
  // runBackup 的假实现抛「不该跑到 runBackup」——说明已越过闸门，正是本用例要的结论。
  await assert.rejects(() => svc.backup('toogel'), /不该跑到 runBackup/);
  assert.equal(n.credentials, 1, '合法用途下口令校验应当发生');
  assert.equal(n.guardHostKey, 1, '合法用途下指纹闸门应当发生');
});

test('GATE-9 老配置（无 role）按备份源处理：restore 被拒', async () => {
  const legacy = { name: 'legacy', host: 'h', user: 'root' };
  const { svc } = makeService([legacy]);
  await assert.rejects(() => svc.restore('legacy', undefined, PKG, {}), /用途/);
});
```

- [ ] **Step 2（2 min）跑测试确认 RED**

```powershell
& $node --test --test-concurrency=1 test\server-role-gate.test.js
```
预期：GATE-1/2/3/4/5 失败（当前没有闸门，会去碰 discover/credentials 等）。

- [ ] **Step 3（6 min）改 `lib/service.js`**

(a) import：

```js
import { assertBackupServer, assertRestoreTarget } from './server-role.js';
```

(b) 在 `findServer` 之后加两个助手：

```js
  /**
   * v0.4.0 用途闸门（纯本地）：取得配置并断言用途。
   *
   * 为什么是纯本地、为什么放在口令校验与指纹闸门之前：
   *  - 纯本地 → 放在最前面不会推迟任何既有错误的暴露时机，也不会引入新的失败路径；
   *  - 在口令之前 → spec §6.3 要求拒绝时 credentials.resolve 次数为 0；
   *  - 在指纹闸门之前 → 用途不符时连 ssh-keyscan 都不该发生。
   * 既有顺序（backup 的「口令先于指纹」）保持不动：那是 R10 fail-closed 的设计，
   * 缺口令时不该先碰远端。
   */
  function requireBackupSource(name) {
    const server = findServer(name);
    assertBackupServer(server);
    return server;
  }

  function requireRestoreTarget(name) {
    const server = findServer(name);
    assertRestoreTarget(server);
    return server;
  }
```

(c) `backup()`：在 `const passphrase = await requirePassphrase('备份');` **之前**插一行

```js
      const server0 = requireBackupSource(name);
```
并在原 `const server = await requireTrusted(name);` 后确认 `server` 仍来自 `requireTrusted`（两者内容等价；助手只负责断言）。
> 若导入 lint 报 `server0` 未使用，把它写成 `requireBackupSource(name);`（不接返回值）——断言是唯一目的。

(d) `inspectRestore()` / `restore()` / `neutralizeStatus()`：各在方法首行加

```js
      requireRestoreTarget(name);
```

(e) `applyNeutralize()`：在 `if (action !== 'keep' && ...)` **之前**加

```js
      // v0.4.0：必须早于 keep 早退——否则同一方法出现「keep 成功、release 被拒」，
      // 且「在备份服务器上保持中立化」语义上不成立。
      requireRestoreTarget(name);
```

- [ ] **Step 4（2 min）跑测试确认 GREEN**

```powershell
& $node --test --test-concurrency=1 test\server-role-gate.test.js
& $node --test --test-concurrency=1 test\neutralize-service.test.js
& $node --test --test-concurrency=1 test\service.test.js
```
预期：全绿。`neutralize-service.test.js` 的 NEUSVC-1 用的是无 `role` 的服务器（按 backup），**它断言 keep 不触远端** —— 该用例会因新闸门变成「keep 被拒」，属于预期语义变更：把它改为给 `makeConfig` 的服务器加 `role: 'restore'`，并在用例顶部注明「v0.4.0：keep 也需要恢复目标用途」。

- [ ] **Step 5（3 min）变异 M-SR2：把 `restore()` 的闸门挪到 `requireTrusted` 之后**

把 `requireRestoreTarget(name);` 移到 `const server = await requireTrusted(name);` 下一行，跑 Step 4：
预期 GATE-1 变红（`guardHostKey` 计数为 1）。**恢复原样**。

---

### Task 4 — 工具路径拒绝且不签发 token

**Files**

- 新增 `test/server-role-tool.test.js`

**Interfaces**

- 消费 `createService`（Task 3 已接线）+ `createOdooRestoreTool`（既有）。
- 本 Task **不改生产代码**：工具层只要把 service 的抛错透出即可；测试证明「工具在服务层拒绝后不会签发 token」。

- [ ] **Step 1（4 min）写测试**

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { createService } from '../lib/service.js';
import { createOdooRestoreTool } from '../lib/tools.js';

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

test('TOOL-2 odoo_restore restore 指向备份源 → 拒绝且不校验 token', async () => {
  const { tool, store } = makeTool();
  await assert.rejects(
    () => tool.execute({ action: 'restore', server: 'toogel', packagePath: 'K:\\Backup\\x.tar.enc', confirmToken: 'whatever' }),
    /用途/,
  );
  assert.equal(store.seen.verify, 0, '拒绝时不该消费 token');
  assert.equal(store.seen.create, 0);
});

test('TOOL-3 指向恢复目标时不会被用途闸门拦住（错误来自后续真实依赖，不是用途）', async () => {
  const { tool } = makeTool();
  await assert.rejects(
    () => tool.execute({ action: 'precheck', server: 'odoo.toogel.cn', packagePath: 'K:\\Backup\\x.tar.enc' }),
    (e) => !/用途/.test(e.message),
  );
});
```

- [ ] **Step 2（2 min）跑测试确认 GREEN（Task 3 已接线）**

```powershell
& $node --test --test-concurrency=1 test\server-role-tool.test.js
```
预期：3 例全绿。若 TOOL-3 因 `inspectRestore` 先做 `findServer` 而报「不该 stat 备份包」之类，仍然满足 `!/用途/`，用例成立。

- [ ] **Step 3（2 min）变异 M-SR3：把 `inspectRestore` 的闸门删掉**

删除 `inspectRestore` 首行 `requireRestoreTarget(name);`，跑 Step 2：
预期 TOOL-1 / TOOL-2 变红。**恢复原样**。

---

### Task 5 — 界面分类、徽章与切换确认

**Files**

- 改 `client.js`
- 新增 `test/client-role-ui.test.js`
- 新增 `test/server-role-render.test.js`

**Interfaces**

- `client.js` 内联 `roleOf` / `partitionServers`（浏览器包不能 import lib，沿用 `isHostname` 内联 + 防漂移断言手法）。
- 组件签名增加测试缝：`function OdooBackupPanel({ scope, locale, initialTab = 'servers' })`，`useState(initialTab)`。

- [ ] **Step 1（4 min）写失败测试（源码契约）**

`test/client-role-ui.test.js`：

```js
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8');
const lib = readFileSync(new URL('../lib/server-role.js', import.meta.url), 'utf8');

test('CRUI-1 两端内联同一判定表达式（防规则漂移）', () => {
  const re = /server\?\.role === 'restore' \? 'restore' : 'backup'/;
  assert.match(client, re, 'client.js 必须内联与 lib 同语义的 roleOf');
  assert.match(lib, re, 'lib/server-role.js 的 roleOf 表达式被改动了？');
});

test('CRUI-2 备份页只渲染备份源、恢复页只渲染恢复目标', () => {
  assert.match(client, /partitionServers\(servers\)/, '必须按用途切分一次');
  assert.match(client, /backupServers\.map\(/, '备份页用 backupServers');
  assert.match(client, /restoreServers\.map\(/, '恢复页用 restoreServers');
  // 反证：三个列表渲染点都不允许再出现裸 servers.map（服务器页除外，它是全量）。
  const bare = [...client.matchAll(/^\s+servers\.map\(/gm)];
  assert.equal(bare.length, 1, `裸 servers.map 只应剩服务器页一处，实际 ${bare.length} 处`);
});

test('CRUI-3 恢复页与中立化卡片共用同一份恢复目标列表', () => {
  const iNeu = client.indexOf('中立化状态（恢复后是否接管生产）');
  assert.ok(iNeu > 0);
  const seg = client.slice(iNeu, iNeu + 4000);
  assert.match(seg, /restoreServers\.map\(/, '中立化卡片必须用同一份过滤结果');
});

test('CRUI-4 空态解释了「为什么生产不在这里」', () => {
  assert.match(client, /尚未配置「恢复目标」服务器/);
  assert.match(client, /备份源不会出现在这里/);
});

test('CRUI-5 切换到恢复目标需要输入服务器名确认', () => {
  assert.match(client, /roleConfirm/, '必须存在用途切换确认状态');
  assert.match(client, /=== *name|name === [A-Za-z]*[Cc]onfirm/, '必须与服务名比对');
});

test('CRUI-6 新服务器草稿与保存都带 role', () => {
  assert.match(client, /role: 'backup'/, '新服务器草稿默认 backup');
  assert.match(client, /role:\s*draft\.role/, '保存时把表单里的用途写入条目');
});

test('CRUI-7 既有「状态可读」闸保留，但不再声称「因为没有用途标记」', () => {
  assert.match(client, /statusKnown/, 'statusKnown 是另一条独立正确的规则，必须保留');
  assert.doesNotMatch(client, /插件没有\s*\n?\s*\/\/\s*「恢复机 vs 生产机」标记/,
    'v0.4.0 已补上用途标记，这句理由要删掉');
});

test('CRUI-8 组件支持 initialTab 测试缝', () => {
  assert.match(client, /initialTab/, '真渲染测试需要直接渲染恢复页');
});
```

- [ ] **Step 2（2 min）跑测试确认 RED**

```powershell
& $node --test --test-concurrency=1 test\client-role-ui.test.js
```
预期：CRUI-1 起全部失败（client.js 还没有 role）。

- [ ] **Step 3（10 min）改 `client.js`**

(a) 内联实现（放在 `isHostname` 之后）：

```js
    // v0.4.0：服务器用途互斥分类。Client 与 Host 不能共享模块（各自独立作用域），
    // 因此内联一份与 lib/server-role.js 严格同语义的实现；
    // test/client-role-ui.test.js 的 CRUI-1 断言两端判定表达式完全一致，防止规则漂移。
    const ROLE_LABELS = { backup: '备份服务器', restore: '恢复目标' };
    const roleOf = (server) => (server?.role === 'restore' ? 'restore' : 'backup');
    const partitionServers = (raw) => {
      const list = Array.isArray(raw) ? raw : [];
      const backup = [];
      const restore = [];
      for (const s of list) (roleOf(s) === 'restore' ? restore : backup).push(s);
      return { backup, restore };
    };
```

(b) 组件签名与 tab 初值：

```js
        function OdooBackupPanel({ scope, locale, initialTab = 'servers' }) {
```
```js
          const [tab, setTab] = useState(initialTab);
```
（`tab` 的声明位置按现有 `useState('servers')` 原地替换。）

(c) `const servers = Array.isArray(config.servers) ? config.servers : [];` 之后加：

```js
          // v0.4.0：一次切分，三处复用（备份页 / 恢复页 / 中立化卡片）。
          // 用数组常量名而不是内联调用，是为了让「恢复页和卡片用同一份」在源码里可见。
          const { backup: backupServers, restore: restoreServers } = partitionServers(servers);
```

(d) 新服务器草稿（`setDraft({ name: '', host: '', ... extraPaths: [] })`，共两处：新增按钮与保存后重置）都补 `role: 'backup'`。

(e) 表单加用途选择（放在 `pinnedFingerprint` 输入框之后、额外路径区块之前）：

```js
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
                  h('label', { style: { fontSize: 12, color: T.text2 } }, '用途'),
                  h('select', {
                    value: draft.role ?? 'backup',
                    'aria-label': '服务器用途',
                    onChange: (e) => { setDraft({ ...draft, role: e.target.value }); setRoleConfirm(''); },
                    style: { ...inputStyle, width: 160, marginBottom: 0 },
                  },
                    h('option', { value: 'backup' }, ROLE_LABELS.backup),
                    h('option', { value: 'restore' }, ROLE_LABELS.restore),
                  ),
                  (draft.role ?? 'backup') === 'restore'
                    && h('span', { style: { fontSize: 12, color: T.warn } },
                      '恢复目标会被备份包覆盖（改库名 + 换 filestore）'),
                ),
                (draft.role ?? 'backup') === 'restore' && h('div', { style: { marginBottom: 8 } },
                  h('div', { style: { fontSize: 12, color: T.text2, marginBottom: 4 } },
                    '确认把用途设为「恢复目标」：请输入服务器名以确认'),
                  h('input', {
                    value: roleConfirm,
                    placeholder: (editingName || draft.name || '').trim() || '服务器名',
                    'aria-label': '用途确认：服务器名',
                    onChange: (e) => setRoleConfirm(e.target.value),
                    style: inputStyle,
                  }),
                ),
```

并在组件状态区加：

```js
          // v0.4.0：切到「恢复目标」是危险方向，要求手输服务器名确认；
          // 反向（恢复目标 → 备份服务器）直接允许，因为它只会让机器从容恢复页消失。
          const [roleConfirm, setRoleConfirm] = useState('');
```

(f) 保存按钮的 `disabled` 增加危险方向确认：

```js
                    disabled: !draft.name.trim() || !draft.host.trim()
                      || ((draft.role ?? 'backup') === 'restore'
                          && roleConfirm.trim() !== (editingName || draft.name).trim()),
```
（`(draft.role === 'restore') && 名称不一致` 时禁用；同时在保存的 `nextServer` 里补 `role: draft.role ?? 'backup',`，并在保存成功后 `setRoleConfirm('');`）

(g) 服务器卡片加徽章（`h('strong', null, s.name),` 之后）：

```js
                    h('span', {
                      style: {
                        marginLeft: 8, fontSize: 11, padding: '1px 6px', borderRadius: 10,
                        border: `1px solid ${roleOf(s) === 'restore' ? T.warn : T.border}`,
                        color: roleOf(s) === 'restore' ? T.warn : T.text2,
                      },
                    }, ROLE_LABELS[roleOf(s)]),
```

(h) 备份页列表：把 `hostTask && hostTask.kind === 'backup' && h(TaskProgress, ...)` 之后的 `servers.map((s) => ...)` 改为 `backupServers.map((s) => ...)`，并在其前插入空态：

```js
              backupServers.length === 0
                && h('p', { style: { color: T.text2, fontSize: 13 } },
                  '当前没有「备份服务器」。请到「服务器」页把用途设为「备份服务器」。'),
```

(i) 恢复页列表：把 `hostTask && hostTask.kind === 'restore' && h(TaskProgress, ...)` 之后的 `servers.map((s) => ...)` 改为 `restoreServers.map((s) => ...)`，并在其前插入空态：

```js
              restoreServers.length === 0
                && h('div', { style: { padding: 12, border: `1px solid ${T.border}`, borderRadius: 6, background: T.bg2, fontSize: 13, color: T.text2 } },
                  h('div', { style: { fontWeight: 600, marginBottom: 4, color: T.text } }, '尚未配置「恢复目标」服务器'),
                  h('div', null,
                    '恢复会覆盖目标库与 filestore，因此备份源不会出现在这里。'
                    + '请到「服务器」页把演练机的用途改为「恢复目标」（该改动需要输入服务器名确认）。'),
                ),
```

(j) 中立化卡片：`servers.map((s) => {` 改为 `restoreServers.map((s) => {`；并把注释 1272-1276 段替换为：

```js
                  // v0.1.18：状态未知（读取失败 / 尚未读到 / 解析失败）绝不出操作按钮。
                  // v0.4.0：这里只渲染恢复目标（restoreServers）——用途已由服务层强制，
                  // 界面过滤是第二道。statusKnown 是另一条独立规则（状态读不到不给按钮），保留。
```

- [ ] **Step 4（3 min）跑源码契约测试确认 GREEN**

```powershell
& $node --test --test-concurrency=1 test\client-role-ui.test.js
& $node --test --test-concurrency=1 test\client-real-render.test.js
& $node --test --test-concurrency=1 test\client-neutralize-ui.test.js
```
预期：全绿。若 `client-neutralize-ui.test.js` 断言了 `servers.map`，按新语义改成 `restoreServers.map`（同一条契约，方向变更）。

- [ ] **Step 5（6 min）写真实渲染测试**

`test/server-role-render.test.js`：

```js
/**
 * 真渲染断言：恢复页 HTML 里不能出现备份源，备份页 HTML 里不能出现恢复目标。
 * 源码 grep 只能证明「写了过滤」，不能证明「页面输出里没有生产服务器」——
 * 本项目已有三次「静态断言全绿但功能没生效」（M26/M67/M82）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const PROFILE = 'C:/Users/Ho/.dsh/profiles/desktop';
const require = createRequire(PROFILE + '/package.json');
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let React;
let renderToStaticMarkup;
try {
  React = require('react');
  ({ renderToStaticMarkup } = require('react-dom/server'));
} catch (e) {
  console.log('SKIP: react/react-dom not resolvable from profile:', e.message.slice(0, 120));
  process.exit(0);
}

const SERVERS = [
  { name: 'toogel', host: '47.121.205.143', user: 'root', role: 'backup' },
  { name: 'odoo.toogel.cn', host: '134.175.51.9', user: 'root', role: 'restore' },
];

const SNAPSHOT = { value: { servers: SERVERS } };

function makeScope() {
  return {
    getSnapshot: () => SNAPSHOT,
    subscribe: () => () => {},
    set: async () => {},
  };
}

/** 用假 configForms 让组件拿到 scope，再按指定 tab 渲染。 */
function renderTab(initialTab) {
  let registered;
  const win = {
    __ModuleLoader__: { load: (d) => { registered = d; } },
    prompt: () => null,
    confirm: () => true,
    setTimeout: () => 0,
  };
  const realST = global.setTimeout;
  const realCT = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  try {
    new Function('window', 'fetch', src)(win, async () => ({ json: async () => ({ ok: true }) }));
  } finally {
    global.setTimeout = realST;
    global.clearTimeout = realCT;
  }

  const scope = makeScope();
  const forms = {
    get: () => scope,
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'odoo-backup' }] } }) }),
  };
  let reg = null;
  const ctx = {
    reflect: { get: () => ({ bind: () => (k) => k }) },
    get: (name) => (name === 'configForms' ? forms : undefined),
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    slots: {
      inject: (key, cb) => { cb(); return () => {}; },
      register: (opts, comp) => { reg = { opts, comp }; return () => {}; },
    },
  };
  registered.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unknown module ' + name);
  }).apply(ctx);

  assert.ok(reg, '必须注册出设置页组件');
  const injected = reg.opts.inject?.() ?? {};
  return renderToStaticMarkup(React.createElement(reg.comp, { ...injected, initialTab }));
}

test('RR-1 恢复页渲染结果不含备份源、含恢复目标', () => {
  const html = renderTab('restore');
  assert.match(html, /odoo\.toogel\.cn/, '恢复目标必须出现');
  assert.doesNotMatch(html, /toogel(?!\.)/, '备份源 toogel 绝不能出现在恢复页');
});

test('RR-2 备份页渲染结果不含恢复目标、含备份源', () => {
  const html = renderTab('backup');
  assert.match(html, /toogel/, '备份源必须出现');
  assert.doesNotMatch(html, /odoo\.toogel\.cn/, '恢复目标绝不能出现在备份页');
});

test('RR-3 恢复页空态：只有备份源时给出解释性空态', () => {
  const html = renderTab('restore');
  // 本用例的 SERVERS 含一台恢复目标，故不应出现空态；反证空态文案不误伤。
  assert.doesNotMatch(html, /尚未配置「恢复目标」服务器/);
});

test('RR-4 备份页空态：只有恢复目标时提示去服务器页', () => {
  // 复用同一渲染器但把快照换成只有恢复目标
  SNAPSHOT.value.servers = [{ name: 'odoo.toogel.cn', host: '134.175.51.9', user: 'root', role: 'restore' }];
  try {
    const html = renderTab('backup');
    assert.match(html, /当前没有「备份服务器」/);
    assert.doesNotMatch(html, /odoo\.toogel\.cn/);
  } finally {
    SNAPSHOT.value.servers = SERVERS;
  }
});
```

- [ ] **Step 6（3 min）跑渲染测试**

```powershell
& $node --test --test-concurrency=1 test\server-role-render.test.js
```
预期：4 例全绿。若 RR-1 的正则把 `odoo.toogel.cn` 里的 `toogel` 误判为备份源，用 `/(^|[^.\w])toogel(?![.\w])/` 精确化——**注意 `odoo.toogel.cn` 本身包含子串 `toogel`**，这是本测试唯一的技术陷阱。

- [ ] **Step 7（5 min）变异 M-SR4：恢复页改用未过滤的 `servers`**

把恢复页的 `restoreServers.map(` 改回 `servers.map(`，跑 Step 6：
预期 RR-1 变红（`toogel` 出现在恢复页）。**恢复原样**。

---

### Task 6 — 变异验证汇总（4 例一次性跑完）

**Files**

- 临时脚本 `_mut_sr.mjs`（跑完删除，不进包、不进仓库）

- [ ] **Step 1（5 min）写变异脚本**

```js
// _mut_sr.mjs — v0.4.0 四个变异，逐个改写源码 → 跑对应测试 → 还原。
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const NODE = 'K:\\DSH\\resources\\runtime\\primary-runtime\\dependencies\\node\\bin\\node.exe';
const FILES = { role: 'lib/server-role.js', service: 'lib/service.js', client: 'client.js' };

const MUTANTS = [
  { id: 'M-SR1', file: 'role',
    from: "server?.role === 'restore' ? 'restore' : 'backup'",
    to: "server?.role === 'backup' ? 'backup' : 'restore'",
    tests: ['test/server-role.test.js'] },
  { id: 'M-SR2', file: 'service',
    from: '      requireRestoreTarget(name);\n      const server = await requireTrusted(name);\n      const pkg = normalizeRestorePath(packagePath);',
    to: '      const server = await requireTrusted(name);\n      requireRestoreTarget(name);\n      const pkg = normalizeRestorePath(packagePath);',
    tests: ['test/server-role-gate.test.js'] },
  { id: 'M-SR3', file: 'service',
    from: '    async inspectRestore(name, packagePath) {\n      requireRestoreTarget(name);\n',
    to: '    async inspectRestore(name, packagePath) {\n',
    tests: ['test/server-role-tool.test.js'] },
  { id: 'M-SR4', file: 'client',
    from: 'restoreServers.map(',
    to: 'servers.map(',
    tests: ['test/server-role-render.test.js'] },
];

function classify(code, out) {
  if (code === 0) return 'SURVIVED';
  const ranTests = /ℹ tests \d+/.test(out);
  const fails = Number((out.match(/ℹ fail (\d+)/) ?? [])[1] ?? 0);
  if (ranTests && fails > 0) return `KILLED(fail=${fails})`;
  const loadErr = (out.match(/SyntaxError: [^\n]*/) ?? [])[0] ?? '(未知加载错误)';
  return `CRASHY(${loadErr.slice(0, 70)})`;
}

let killed = 0;
for (const m of MUTANTS) {
  const path = FILES[m.file];
  const orig = readFileSync(path, 'utf8');
  const cnt = orig.split(m.from).length - 1;
  if (cnt !== 1) { console.log(`${m.id} NO-ANCHOR(cnt=${cnt})`); continue; }
  writeFileSync(path, orig.replace(m.from, m.to));
  let code = 0; let out = '';
  try {
    out = execFileSync(NODE, ['--test', '--test-concurrency=1', ...m.tests], { encoding: 'utf8' });
  } catch (e) { code = e.status ?? 1; out = `${e.stdout ?? ''}${e.stderr ?? ''}`; }
  writeFileSync(path, orig);
  const verdict = classify(code, out);
  if (verdict.startsWith('KILLED')) killed += 1;
  console.log(`${m.id} ${verdict}`);
}
console.log(`SUMMARY killed=${killed}/${MUTANTS.length}`);
```

- [ ] **Step 2（3 min）跑变异**

```powershell
& $node _mut_sr.mjs
```
预期：`SUMMARY killed=4/4`。任一 `SURVIVED` → 补测试（不是放宽口径）；任一 `CRASHY` → 检查锚点或变异写法是否造成语法错误（假杀）。

- [ ] **Step 3（1 min）删除临时脚本**

```powershell
Remove-Item _mut_sr.mjs -Force
```

---

### Task 7 — 配置迁移 + 真机只读验证 + 全量回归

**Files**

- 改 `C:\Users\Ho\.dsh\profiles\desktop\cordis.patch.yml`（仅两个 `role` 字段）

- [ ] **Step 1（2 min）备份配置并记录指纹**

```powershell
$p='C:\Users\Ho\.dsh\profiles\desktop\cordis.patch.yml'
Copy-Item $p "$p.bak-pre-role-20261126" -Force
Get-FileHash $p -Algorithm SHA256 | Select-Object HasValue, Hash
```

- [ ] **Step 2（4 min）用 `edit` 精确插入两个 role 字段**

- `toogel` 条目：`dbPort:` 行之后加 `role: backup`。
- `odoo.toogel.cn` 条目：`dbName: "toogel"` 行之后加 `role: restore`。

**不要**重写整个文件（历史教训：自写 YAML 解析器改生产配置导致 `expected exactly 1 server, got 7`）。

- [ ] **Step 3（3 min）用 js-yaml 复核（脚本必须放 profile 目录）**

```powershell
$dir='C:\Users\Ho\.dsh\profiles\desktop'
Set-Content "$dir\_rolecheck.cjs" @'
const yaml=require('js-yaml');const fs=require('fs');
const cfg=yaml.load(fs.readFileSync('cordis.patch.yml','utf8'));
const servers=cfg.find(e=>e.id==='odoo-backup').config.servers;
for(const s of servers) console.log(`${s.name}\trole=${s.role}\tdbName=${s.dbName}\textraPaths=${(s.extraPaths||[]).length}\textraFiles=${(s.extraFiles||[]).length}`);
'@
Push-Location $dir; & $node _rolecheck.cjs; Remove-Item _rolecheck.cjs -Force; Pop-Location
```
预期：
```
toogel	role=backup	dbName=undefined	extraPaths=8	extraFiles=3
odoo.toogel.cn	role=restore	dbName=toogel	extraPaths=0	extraFiles=0
```

- [ ] **Step 4（3 min）确认指纹与其余字段零变化**

```powershell
$a=(Get-Content "$p.bak-pre-role-20261126" -Raw) -split "`n"
$b=(Get-Content $p -Raw) -split "`n"
Compare-Object $a $b | Format-Table -AutoSize
```
预期：**只有两行差异**（两个 `role:` 新增）；`pinnedFingerprint`、`extraPaths`、`extraFiles`、`depsLocks`、`maxBytes` 均未变。

- [ ] **Step 5（5 min）真机只读验证（生产零变更）**

生产（只读）：
```powershell
# 只读：确认生产库与 WAF 状态未变
ssh -i H:\odoo\key\odoo-backup root@47.121.205.143 'docker exec 1Panel-postgresql-3eaO psql -U toogel -tAc "select count(*) from pg_database where datname like %restore% or datname like %-old-%" ; cat /opt/1panel/apps/openresty/openresty/1pwaf/data/conf/global.json'
```
预期：库计数 `0`、`"state": "off"`。

测试机（允许，属迁移验证）：
```powershell
ssh -i H:\odoo\key\odoo-backup root@134.175.51.9 'echo OK; docker ps --format "{{.Names}} {{.Status}}"'
```
预期：三容器略，无失败。

- [ ] **Step 6（6 min）全量回归**

```powershell
$files = Get-ChildItem test -Filter *.test.js | ForEach-Object { $_.FullName }
& $node --test --test-concurrency=1 @files 2>&1 | Select-Object -Last 12
```
预期：`# pass` ≥ 1129 + 新增（13 + 3 + 9 + 3 + 8 + 4 = 40 左右），`# fail 0`。

---

### Task 8 — 版本 0.4.0、文档六处、发布与装机

**Files**

- `package.json`、`CHANGELOG.md`、`CHANGELOG.zh-CN.md`、`README.md`、`README.zh-CN.md`

- [ ] **Step 1（4 min）`package.json` 版本 `0.3.2` → `0.4.0`**

- [ ] **Step 2（10 min）双 CHANGELOG 各插 `## [0.4.0] — 2026-11-26`**

必须写清三件事：

1. **行为变更**：服务器新增 `role` 字段，备份源与恢复目标互斥；老配置默认按 `backup`，因此**升级后恢复页会变空**，需到「服务器」页把演练机改为「恢复目标」。
2. **服务层强制**：`restore` / `inspectRestore` / `neutralizeStatus` / `applyNeutralize` 对备份源一律拒绝，且拒绝发生在任何口令校验、指纹校验与远端动作之前。
3. **`applyNeutralize(keep)` 行为收紧**：现在也会读配置并断言用途，对不存在的服务器名从「静默成功」变为抛「未找到服务器」。

英文一句话主题建议：**"the plugin knew how to reach a server but not what the server was for — and the restore page listed production."**

- [ ] **Step 3（8 min）双 README 同步**

- 版本号 `0.4.0`、安装源 `#v0.4.0`
- 测试数改为 Step 6 的实际值
- 「服务器」章节加一段：备份服务器 / 恢复目标互斥、切换需输名确认、恢复页为什么可能为空
- README 历史区间行改 `0.1.0 → 0.4.0`

- [ ] **Step 4（5 min）dry-run**

```powershell
& $node scripts\publish-release.mjs --dry-run
```
预期：`pass=<新测试数> fail=0`、`✓ lib 下所有 .js 都已进包`、`✓ 包内 index.js 可加载`、`DRY-RUN OK`。

- [ ] **Step 5（6 min）正式发布**

```powershell
& $node scripts\publish-release.mjs
& $node scripts\release-sync-check.mjs
```
预期：commit + tag `v0.4.0` + Release + 附件；`ALL SYNCED ✓`。
若遇 GitHub 连接抖动（历史常见）：`install_bundle` 改用本地制品 `K:\Backup\odoo-plugin-releases\packages\dsh-odoo-backup-0.4.0.tgz`，不要为绕过它去改 `http.curloptResolve`（pnpm 不认该配置）。

- [ ] **Step 6（4 min）装机与装后核验**

```powershell
# 1) 移除旧版 → 2) 安装 v0.4.0（install_bundle）
# 3) 核验：装机目录与工作区 SHA256 一致
```
预期：`version: 0.4.0`、`application: applied`、`warnings: []`；`lib/server-role.js` 两边 SHA256 相同；`test/` 未随包。

- [ ] **Step 7（4 min）装机后人工验收（只读）**

- 打开插件设置页 → 「服务器」页：两台服务器分别显示「备份服务器」「恢复目标」徽章。
- 「备份」页：只有 `toogel`。
- 「恢复」页：只有 `odoo.toogel.cn`；中立化卡片同样只有它。
- 用 Agent 工具 `odoo_restore action=precheck server=toogel packagePath=<任意>` → 返回用途错误，**不产生 token**。

---

## 5. 自审

**Spec 覆盖**

| spec 章节 | 落地 Task |
|---|---|
| §3 分类模型（互斥） | Task 1（`SERVER_ROLES` / `partitionServers`） |
| §4 数据模型 `role` | Task 2 |
| §5 `normalizeServerRole` / `roleOf` 职责分离 | Task 1（SR-1~SR-6）+ Task 2（写入校验） |
| §6.1/6.2 闸门顺序与覆盖清单 | Task 3（GATE-1~GATE-9） |
| §6.3 九类依赖为 0 | Task 3（`assertAllZero`） |
| §6.2 keep 收紧说明 | Task 3（GATE-5/6）+ Task 8 Step 2 |
| §7.1 徽章/表单/确认 | Task 5（d/e/g） |
| §7.2 恢复页过滤+空态+删代理闸理由 | Task 5（i/j）+ CRUI-3/4/7 |
| §7.3 备份页过滤+空态 | Task 5（h）+ RR-2/RR-4 |
| §8 迁移 | Task 7 |
| §9 SR-T1~T11 | Task 1/3/4/5/6/7 全覆盖（T9→RR-1~4，T10→Task 6） |
| §10 SR-1~SR-9 | Task 7（SR-1/5/9）+ Step 7（SR-2/3/4/6） |

**占位符扫描**：无 TBD/TODO；每个 Task 都给了可运行代码与预期输出。

**命名一致性**：`role` / `roleOf` / `partitionServers` / `requireBackupSource` / `requireRestoreTarget` / `backupServers` / `restoreServers` / `initialTab` / `roleConfirm` / `statusKnown` 全程同名。

## 6. 执行方式

Inline 执行（本会话），不新增审核门——用户 m08593 已批准。执行顺序即 Task 1→8，逐 Task 跑测试；发现规格外问题就地修正并在最终报告中列出，不因此中断为审核流程。
