# 服务器用途隔离（备份源 / 恢复目标）设计规格

- 日期：2026-11-26
- 版本目标：`v0.4.0`
- 状态：待复核
- 关联：`lib/service.js`、`lib/tools.js`、`client.js`、`index.js`；用户裁决 m08520

## 0. 一句话原则

**服务器用途决定它能否进入备份或恢复操作，而不是依赖界面隐藏按钮。**

界面隐藏是给人看的；真正拦住误操作的是服务层断言。二者都做，但只有后者是安全控制。

## 1. 问题（源码实证）

插件不存在「服务器用途」这一概念。`servers[]` 是扁平数组，同一份数组同时喂给备份页、恢复页与中立化卡片：

| 位置 | 内容 | 风险 |
|---|---|---|
| `client.js:1095` | 备份页 `servers.map` | 无（备份是安全方向） |
| `client.js:1194` | 恢复页 `servers.map`，每台一个路径输入框 + `tone:'danger'` 按钮 | **高：生产服务器在列表内** |
| `client.js:1269` | 中立化卡片 `servers.map`，「解除中立化（接管生产）」danger 按钮 | **高** |
| `client.js:955` | 服务器页 | 正常（此处应出现全部服务器） |

三条入口最终都汇到服务层，但唯一的共同闸门 `requireTrusted`（`lib/service.js:152`）只校验**主机指纹**（「你是不是我以为的那台机器」），不校验**用途**（「这台机器该不该被覆盖」）：

| 入口 | 路径 | 经过界面 |
|---|---|---|
| 界面恢复 | `/precheck`（`index.js:514`）→ token → `/restore`（`index.js:562`）→ `service.restore`（`lib/service.js:405`） | 是 |
| Agent 工具 | `odoo_restore`（`lib/tools.js:162`）→ `service.inspectRestore`（`lib/service.js:309`）/ `service.restore` | **否** |
| 中立化 | `/neutralize-precheck`（`index.js:590`）/ `/neutralize-apply`（`index.js:625`）→ `service.neutralizeStatus`（`lib/service.js:549`）/ `service.applyNeutralize`（`lib/service.js:571`） | 是 |

破坏性来自 `lib/restore.js:692-716` 的 `RENAME_OLD` / `RENAME_NEW`（`ALTER DATABASE ... RENAME`）：指错目标即生产库被改名、临时库顶替、filestore 被替换，随后回写 `dbfilter` 并重启容器。

代码自身已记录该概念的缺失（`client.js:1272-1276`）：

> 中立化按钮语义上是「恢复目标机」专属（接管生产决定），**插件没有「恢复机 vs 生产机」标记**，所以用「状态可读」做闸。

这是用代理条件代替真实概念：生产机状态读得到时，danger 按钮照常出现。本规格补上真实概念并替换该代理条件。

## 2. 目标与非目标

**目标**

1. 一台服务器**只能**是一种用途：`backup`（备份源）或 `restore`（恢复目标），互斥。
2. 恢复页只显示恢复目标；备份页只显示备份源；中立化操作只出现在恢复目标上。
3. 任何破坏性入口（界面、工具、未来调用方）在**任何副作用之前**按用途拒绝。
4. 老配置无需手工迁移即可继续备份；危险方向（把生产当恢复目标）必须显式操作且需确认。

**非目标**（本轮明确不做）

- 不重构配置加载层，不拆成两个数组。
- 不改变 `requireTrusted`、`serverKeys`、`server-config-id` 的既有语义。
- 不做服务器删除二次确认（独立小 bugfix）。
- 不做恢复前手输目标库名（P2，不作为 v0.4.0 发布判据）。
- 不触碰 WAF、Phase 2；不推进 attendance `depsLocks`（已批准，待本轮结束后作为独立小改动）。

## 3. 分类模型

两类互斥，无 `both`。理由：一旦允许「既是备份源又是恢复目标」，恢复页必须再次面对生产服务器，隔离就失效了。

| 用途 | 值 | 允许的操作 | 界面可见位置 |
|---|---|---|---|
| 备份服务器 | `backup` | 备份、发现、测试连接、扫描外部依赖、信任主机 | 服务器页、备份页 |
| 恢复目标 | `restore` | 恢复、预检、中立化、发现、测试连接、信任主机 | 服务器页、恢复页 |

只读操作（`/test`、`/discover`、`/fingerprint`、`/scanExternalDeps`）对两类都开放——服务器页必须能对任何一台测连接。

## 4. 数据模型

`index.js` 的 server 对象新增一个字段：

```js
role: z
  .union([z.const('backup'), z.const('restore')])
  .default('backup')
  .description(
    '服务器用途（v0.4.0）：backup=备份源（默认，生产服务器）／restore=恢复目标（会被覆盖）。'
    + '两类互斥：备份源绝不出现在恢复列表，恢复目标绝不出现在备份列表',
  ),
```

用 `z.union([z.const(...)])` 而非 `z.enum`，与既有 `maxBytes` 写法一致，不依赖 schemastery 是否提供 enum。

**默认值方向**：`backup`。缺失、非法、拼错一律落到安全侧（不进恢复列表）。

## 5. 纯函数层 `lib/server-role.js`

两个函数的职责必须分开，这是本设计的核心约定：

| 函数 | 时机 | 行为 |
|---|---|---|
| `normalizeServerRole(value)` | **配置写入时**（保存服务器、加载校验） | 严格校验：只接受 `'backup'` / `'restore'`；缺失 → `{ ok:true, role:'backup' }`；其余一律 `{ ok:false, reason }`，拒绝保存 |
| `roleOf(server)` | **运行时**判定 | 只认精确 `'restore'`，其余全部返回 `'backup'`；**不修改入参、不自动修复、不持久化** |

`roleOf` 的容错方向写死为「异常 → backup」，因此配置损坏的结果是「恢复页少一台机器」，而不是「生产出现在恢复页」。

导出清单：

```js
export const SERVER_ROLES = ['backup', 'restore'];
export const ROLE_LABELS = { backup: '备份服务器', restore: '恢复目标' };
export function normalizeServerRole(value);   // → { ok, role?, reason? }
export function roleOf(server);               // → 'backup' | 'restore'，纯函数
export function canBackup(server);            // → boolean
export function canRestore(server);           // → boolean
export function assertBackupServer(server);   // 违规抛错
export function assertRestoreTarget(server);  // 违规抛错
export function partitionServers(list);       // → { backup: [], restore: [] }，保持原顺序
```

`partitionServers` 对非数组输入返回两个空数组（界面拿到脏配置也不崩）。

**拒绝文案**（可操作，不只说「不允许」）：

> 服务器「`<name>`」的用途是「备份服务器」，不能作为恢复目标。恢复会 `ALTER DATABASE ... RENAME` 覆盖目标库并替换 filestore，因此只允许用途为「恢复目标」的服务器执行。如果这台机器确实是演练机，请到「服务器」页把用途改为「恢复目标」（该改动需要输入服务器名确认）。

对称文案（对恢复目标执行备份时）：

> 服务器「`<name>`」的用途是「恢复目标」，不能作为备份源。恢复目标的内容来自备份包，对它备份会产生一份「看起来像生产、其实不是」的快照。请到「服务器」页把用途改为「备份服务器」。

## 6. 服务层闸门

### 6.1 精确表述

> 每个破坏性操作入口，**在解析并取得目标服务器配置之后、任何副作用之前**立即执行对应的 role assertion。在 assertion 成功之前，不得执行口令校验、SSH 指纹校验、远端发现、远端连接、token 签发，或任何远端操作。

实现形态：**两个纯本地的取配置助手**，放在每个破坏性入口的最前面。

```js
/**
 * 破坏性入口第一行：取得目标配置并断言用途。
 * 纯本地（config 数组 find + 字段判断），无凭证、无网络、无文件写入。
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

入口只需把原来的 `const server = await requireTrusted(name)` 拆成两行，**其余顺序一字不改**：

```js
// service.restore / inspectRestore / neutralizeStatus
const server = requireRestoreTarget(name);   // 纯本地断言
const trusted = await requireTrusted(name);  // 指纹闸门（既有第二道，位置不变）
```

三条要点：

1. **`requireTrusted` 本体不改**（它被 `/test`、`/discover`、`/fingerprint`、`/scanExternalDeps` 共用，那些入口对两类服务器都合法）。
2. **不重复读配置**：助手返回的就是完整 server 对象，后续使用它；`requireTrusted` 内部那一次 `findServer` 是既有行为，不新增。
3. **不改动既有检查的相对顺序**，因为顺序里本身带着设计意图：
   - `service.backup` 的注释写明「口令校验在指纹闸门与任何远端发现**之前**，让 UI / Agent 拿到明确可操作的错误，且绝不触达远端」（R10 fail-closed）。若把指纹闸门提前，缺口令时会先发生 `ssh-keyscan`，等于为了报告一个本地缺项而先碰了远端。
   - 因此 `backup` 的正确顺序是：**用途断言（本地）→ 口令 → 指纹闸门 → 远端发现**。用途断言插在第一，口令与指纹的先后保持原样。

由于助手是纯本地的，把它放在最前面不会推迟任何既有错误的暴露时机，也不会引入新的失败路径。

### 6.2 覆盖清单

| 入口 | 首行断言 | 之后保持原样的既有顺序 |
|---|---|---|
| `service.backup(name)` | `requireBackupSource` | `requirePassphrase('备份')` → `requireTrusted` → `discover` → 三项配置校验 |
| `service.inspectRestore(name, …)` | `requireRestoreTarget` | `requireTrusted` → `discover` → `requirePassphrase` → `readPackageMeta` |
| `service.restore(name, …)` | `requireRestoreTarget` | `requireTrusted` → `normalizeRestorePath` → `stat` → `detectFormat` → `discover` → `requirePassphrase` → 版本闸门 |
| `service.neutralizeStatus(name)` | `requireRestoreTarget` | `requireTrusted` → `discover` → `execRemote` |
| `service.applyNeutralize(name, action, …)` | `requireRestoreTarget` | `action` 校验 → `keep` 早退 → `requireTrusted` → `discover` → `execRemote` |

`applyNeutralize` 的 `keep` 分支没有副作用，仍要断言：否则同一方法会出现「keep 成功、release 被拒」的割裂状态，且「在备份服务器上保持中立化」语义上不成立。

**由此产生一处有意的行为收紧**（必须写进 CHANGELOG）：`applyNeutralize(name, 'keep')` 目前**完全不读配置**（在任何 `findServer` 之前就返回成功），因此对一个不存在的服务器名也会返回 ok。加上首行断言后，`keep` 对「不存在的服务器」和「备份服务器」都会抛错。后者是本设计的目的，前者是一致性收益（避免了一个谎报成功的路径）。

### 6.3 可验证判据（本设计的验收核心）

对一台 `role !== 'restore'` 的服务器调用 `service.restore` / `inspectRestore` / `neutralizeStatus` / `applyNeutralize`，必须同时满足：

1. 抛出 `Error`，消息包含该服务器名与「用途」二字；
2. 以下依赖的调用次数**全部为 0**：`credentials.resolve`、`guardHostKey`、`discover`、`execRemote`、`scpUpload`、`scpDownload`、`stat`、`detectFormat`、`readPackageMeta`；
3. 不签发 `confirmToken`（`/precheck`、`/neutralize-precheck` 返回错误而非 200）。

对 `role === 'backup'` 的服务器调用 `service.backup` 正常；对 `role === 'restore'` 的调用被拒且 `credentials.resolve` 次数为 0。

第 2 条里 `credentials.resolve` 必须为 0，是本次相对既有实现唯一需要调整顺序的地方——`backup` 的既有顺序把口令校验放在指纹闸门之前，用途断言必须插到口令之前，所以断言是纯本地的（不做凭证、不做网络）。

## 7. 界面

### 7.1 服务器页

- 每张卡片增加用途徽章：`恢复目标`（警示色 + 说明「会被备份包覆盖」）、`备份服务器`（常规色）。
- 新增/编辑表单增加用途选择，默认「备份服务器」；新服务器草稿（`client.js:940`）同步加上 `role: 'backup'`，否则新建的服务器落到缺字段状态、只能靠 `roleOf` 的兜底。
- **切换到「恢复目标」需要输入该服务器名确认**：输入框与 `name` 不一致时保存按钮禁用。反向（恢复目标 → 备份服务器）直接允许，提示「它将从恢复页消失」。
- 删除确认**不在本轮范围**。

### 7.2 恢复页

- 只渲染 `roleOf(s) === 'restore'` 的服务器；中立化卡片使用同一份过滤结果。
- 无恢复目标时的空态（必须解释「为什么生产不在这里」）：

> 尚未配置「恢复目标」服务器。恢复会覆盖目标库与 filestore，因此备份源不会出现在这里。请到「服务器」页把演练机的用途改为「恢复目标」。

- 删除 `client.js:1272-1276` 中「插件没有恢复机 vs 生产机标记，所以用状态可读做闸」的理由，改为引用真实 role；`statusKnown`（`client.js:1277`，状态未知不出按钮）**保留**，它是另一条独立且正确的规则。

### 7.3 备份页

- 只渲染 `roleOf(s) === 'backup'` 的服务器；空态提示「当前没有备份源，请到「服务器」页把用途设为「备份服务器」」。

### 7.4 可选的额外摩擦（P2，非发布判据）

点击恢复 danger 按钮后要求手输目标库名才提交。实现成本低，但不作为 v0.4.0 的验收条件。

## 8. 迁移

1. 老配置无 `role` → 运行时按 `backup`（安全生产）。
2. 服务器页顶部一次性提示：「检测到 N 台服务器未设置用途，已按「备份服务器」处理」。
3. **本机配置必须显式改一处**：`odoo.toogel.cn` 设为 `role: restore`，否则演练机从恢复页消失；`toogel` 显式写 `role: backup`，让配置自解释。
4. `role` 不参与 `serverIdOf`（该摘要只含 host/port/user/sshConfigAlias），改用途不会改变任务归属、锁键或状态目录——这一点要在规格里写明，避免有人误以为需要重建状态。

## 9. 测试

| 编号 | 内容 |
|---|---|
| SR-T1 | `normalizeServerRole`：缺失→backup ok；`'restore'` ok；`'RESTORE'`/`'restroe'`/数字→拒绝 |
| SR-T2 | `roleOf`：精确 restore 才返回 restore；`'RESTORE'`、`''`、`null`、缺失→backup；**不修改入参**（`Object.freeze` 输入不抛错，且对象前后深相等） |
| SR-T3 | `partitionServers`：顺序保持、两类不交叉、脏配置不崩 |
| SR-T4 | 断言文案包含服务器名 + 「用途」+ 破坏性说明 |
| SR-T5 | **服务层行为**：对备份服务器调 `restore`/`inspectRestore`/`neutralizeStatus`/`applyNeutralize` 各自抛错，且 9 个依赖调用次数全为 0（见 §6.3） |
| SR-T6 | `applyNeutralize` 的 `keep` 分支：对备份服务器被拒；对**不存在的服务器名**也抛「未找到服务器」（行为收紧，见 §6.2） |
| SR-T7 | `service.backup` 对恢复目标被拒且 `credentials.resolve` 为 0；对备份服务器正常 |
| SR-T8 | `odoo_restore action=precheck` 指向备份服务器 → 返回错误且**不签发 token**；`/neutralize-precheck` 同样 |
| SR-T9 | **GUI 真实渲染**（复用 `test/client-real-render.test.js` 的 react-dom/server harness）：恢复页 HTML 不含备份服务器名、含恢复目标名；备份页相反；中立化卡片只含恢复目标 |
| SR-T10 | 变异验证，四例全 KILLED：① `roleOf` 默认值改成 `restore`；② 闸门挪到 `requireTrusted` 之后；③ 恢复页改用未过滤的 `servers`；④ `service.restore` 去掉断言只留界面过滤 |
| SR-T11 | 真机只读：`odoo_restore action=precheck server=toogel` 被拒；界面恢复页不含生产服务器；生产侧无任何变更（`installed`/`restore_dbs`/`waf_state` 复核） |

**为什么 GUI 必须用渲染断言**：源码 grep 只能证明「代码里写了过滤」，不能证明「页面输出里真的没有生产服务器」。本项目已有三次「静态断言全绿但功能没生效」的实证（`M26`/`M67`/`M82`），此处不再重复。

## 10. 验收判据

| 编号 | 判据 |
|---|---|
| SR-1 | 配置里 `toogel` 为 `backup`、`odoo.toogel.cn` 为 `restore`，且两者互不出现于对方的操作页 |
| SR-2 | 对 `toogel` 执行 `odoo_restore`（precheck 与 restore）均被拒，且不产生 token |
| SR-3 | 对 `toogel` 执行 `service.backup` 正常（安全生产不受影响） |
| SR-4 | 对 `odoo.toogel.cn` 执行 `service.backup` 被拒 |
| SR-5 | 拒绝时 9 类远端/凭证依赖调用次数为 0 |
| SR-6 | 恢复页渲染输出不含 `toogel`，备份页渲染输出不含 `odoo.toogel.cn` |
| SR-7 | 老配置（无 `role`）加载后仍可备份，且不出现在恢复页 |
| SR-8 | 全量测试通过（基线 1129）+ GUI 真实渲染用例；变异 4/4 KILLED |
| SR-9 | 生产主机零变更（只读复核 `installed=169`、`restore_dbs=0`、`waf_state=off`） |

## 11. 变更记录

| 版本 | 日期 | 变更 |
|---|---|---|
| v1.0 | 2026-11-26 | 初版：按用户裁决 A（服务层单一闸门 + 互斥两类）编写；吸收 m08520 三点调整——`normalizeServerRole`/`roleOf` 职责分离且运行时不改配置、闸门精确表述为「取得配置后、任何副作用之前」并以依赖调用次数为判据、删除确认移出 v0.4.0 范围 |
| v1.1 | 2026-11-26 | 自检修正三处：① §6.1 闸门助手改为**纯本地** `requireBackupSource`/`requireRestoreTarget`（原稿让助手内部调 `requireTrusted`，会打乱 `backup` 既有的「口令在校验指纹之前」顺序，缺口令时先发生 `ssh-keyscan`）；② §6.2 新增「`applyNeutralize` keep 分支行为收紧」说明——它目前连 `findServer` 都没走，加断言后对不存在的服务器名也会抛错；③ 修正 `client.js` 注释行号 `1273-1275` → `1272-1276`，并标明 `statusKnown` 在 `1277` |
