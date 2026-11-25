# 灾备边界规格：预置运行环境 vs 恢复业务状态

- 版本：1.0
- 日期：2026-11-24
- 状态：待用户批准（本文档只定义边界与判定规则，不含配置改动）
- 前置文档：`2026-11-23-external-service-discovery-spec.md`

---

## 0. 一句话

**基础设施负责提前准备，灾备系统负责恢复业务状态。**

灾备包不保存任何"能重新装一遍"的东西：不存程序安装树、不存镜像、不存 venv、不存包管理器产物、不存运行日志、不存进程运行状态。灾备包只保存"装完也变不出来"的东西：**业务数据、业务配置、密钥、以及恢复动作本身需要知道的版本与来源信息**。

这一条替代了 v0.2.8 之前的隐含假设——"服务器上跑着什么，就尽量把相关的都打包进去"。那个假设在 2026-11-24 的真机盘点里被证明造成了三类实际错位（见 §7）。

---

## 1. 四分类（Discovery 必须输出）

Discovery 对每个发现的资产必须给出且只给出一个 `disposition`：

| 分类 | 含义 | 进灾备包 | 必须记录 | 典型例子 |
|---|---|---|---|---|
| `PREINSTALLED_RUNTIME` | 预先安装的运行环境，恢复时重新准备 | **否** | 版本、镜像 digest、安装来源、依赖 | 1Panel 平台本体、PostgreSQL 软件、OpenResty 程序、Hermes Agent 运行时、WAF 程序 |
| `RESTORE_REQUIRED` | 必须从灾备恢复的配置或数据 | **是** | 来源路径、SHA-256、恢复落点、恢复顺序 | Odoo 库、filestore、addons、odoo.conf、Hermes 配置/记忆/技能、nginx 站点与反代配置、证书、WAF 站点规则 |
| `REBUILDABLE_DEPENDENCY` | 可重新安装或下载，但必须记录如何重建 | **否** | 版本、来源 URL、校验方式、重建命令 | Python venv、embedding 模型权重、WAF geo mmdb、`pg_trgm` 扩展、Docker 镜像、npm 包 |
| `EXCLUDED` | 与业务状态无关，不纳入灾备 | 否 | 排除原因（可审计） | 运行日志、`__pycache__`、缓存、临时文件、`.pytest_cache` |

### 1.1 四个分类不是互斥的资产属性，是互斥的**处置决定**

同一个物理目录里可以同时存在四种资产。例如 `/opt/1panel/apps/openresty/openresty/1pwaf/data`：

- `conf/sites.json`、`conf/global.json`、`sites/**` → `RESTORE_REQUIRED`
- `geo/*.mmdb` → `REBUILDABLE_DEPENDENCY`
- `db/**/*.db` → `EXCLUDED`（运行状态，实测 389 行全是程序字典，无业务数据）
- `rules/'', `default/`, `html/` → `PREINSTALLED_RUNTIME`（镜像自带，与安装时刻 mtime 一致）

因此**不能按目录给分类，必须按目录内的资产粒度给分类**。这是本规格对 Discovery 的硬要求。

### 1.2 判定顺序（短路，先命中先返回）

1. 命中排除特征（日志/缓存/临时/`__pycache__`/lock/socket/pid）→ `EXCLUDED`
2. 位于已知 `REBUILDABLE_DEPENDENCY` 特征（`venv`/`node_modules`/`*.mmdb`/模型权重目录/`*.tar.zst` 镜像层缓存）→ `REBUILDABLE_DEPENDENCY`
3. 命中 `PREINSTALLED_RUNTIME` 特征（容器镜像安装树、包管理器路径 `/usr`/`/lib`/`/snap`、1Panel 应用程序的 `bin`/`lib`/`modules`/`root`/`html` 子目录、与镜像构建时间同 mtime 的程序资源）→ `PREINSTALLED_RUNTIME`
4. 其余 → `RESTORE_REQUIRED`

**默认落到 `RESTORE_REQUIRED` 而不是 `EXCLUDED`**。理由：漏备份的代价是不可恢复，多打包的代价只是包大一点。但"默认"不等于"不检查"，第 4 步之后必须有 `reasons` 说明凭什么判定为需要恢复。

### 1.3 与既有 `coverage` 五态的关系

`coverage`（`main`/`extraPaths`/`l2`/`none`/`unverified`）回答"**备份在哪**"。
`disposition` 回答"**该不该备份**"。

两者正交，必须同时输出：

- `PREINSTALLED_RUNTIME` + `coverage: none` → **正确**，不是缺口
- `RESTORE_REQUIRED` + `coverage: none` → **真缺口**，必须进 suggest
- `REBUILDABLE_DEPENDENCY` + `coverage: none` → **正确**，但必须能从报告查到"怎么重建"
- `RESTORE_REQUIRED` + `coverage: extraPaths` → 已覆盖，但若在 `PRESTALLED_RUNTIME` 路径下要注意 exclude 是否误伤

**这是本规格最关键的一条**：v0.2.8 的 suggest 之所以会把 `/opt/1panel/apps/openresty/openresty/root`、`.../modules`、`.../conf/nginx.conf` 判成缺口，就是因为只有 `coverage` 没有 `disposition`——"没备份"被直接当成"该备份"。

---

## 2. 职责表（用户裁决的固化）

| 组件 | 预先安装（`PREINSTALLED_RUNTIME`） | 灾备恢复（`RESTORE_REQUIRED`） |
|---|---|---|
| 1Panel | 整个平台（`/opt/1panel` 本体、panel db、agent） | **不恢复平台本体** |
| PostgreSQL | 软件及运行环境（镜像 `postgres:18.4-alpine`） | Odoo 数据库、必要角色与权限、`pg_trgm` 扩展声明 |
| Hermes | Agent 运行环境（`/root/.hermes/{node,installs,bin,lsp,tools}`） | 配置、记忆、技能、知识库、密钥 |
| OpenResty | Web 服务及运行环境（镜像、`1pwaf` 程序、`rules/`/`default/`/`html/`） | 站点配置、证书、反向代理配置、WAF 站点规则 |
| Odoo | 运行环境按恢复方案准备（镜像、`venv`/`pydeps` 已另有机制） | 数据库、模块、filestore、配置 |
| WAF | 程序及运行环境 | Odoo 相关规则、站点配置 |

### 2.1 两个"特别注意"的具体落地

**PostgreSQL：预装 ≠ 只恢复数据文件。**

主备份用 `odoo db dump --format=zip`，其内部命令是 `pg_dump --no-owner`（已取证：`/usr/lib/python3/dist-packages/odoo/service/db.py:285`）。由此产生三个必须显式记录、否则恢复会静默降级的项：

| 项 | 实测值 | 不记录的后果 |
|---|---|---|
| 角色 | `toogel`(super)、`tugou`(非 super) | `--no-owner` 恢复后所有对象归执行恢复的角色；若 Odoo 用 `tugou` 连库则权限可能不符 |
| 库 collate | `tg-odoo` 是 **`C`**，而 `template1`/`odoo19` 是 `en_US.utf8` | 恢复时若用默认模板建库，排序规则不同 → 707 个唯一索引里含 text 列的会**建索引失败或排序结果改变** |
| 扩展 | `pg_trgm 1.6`、`plpgsql` | `pg_trgm` 不在 core，需 `postgres-contrib`；未装则 `CREATE EXTENSION` 失败，`dump.sql` 里有 1 次 `CREATE EXTENSION`、4 次 `pg_trgm` 引用 |

**这三项必须进恢复清单，且必须记录实测值而不是"应有值"。**

**Hermes：预装 ≠ 数据可忽略。**

`/root/.hermes` 下两类资产必须分开：

| 路径 | 分类 | 实测体积 |
|---|---|---|
| `config.yaml`、`SOUL.md`、`auth.json`、`memories/`、`skills/`、`secrets/`、`cron/jobs.json` | `RESTORE_REQUIRED` | 配置 16 KB、skills **70.8 MB**、memories 6 KB |
| `node/`、`installs/`、`bin/`、`lsp/`、`tools/`、`cache/`、`state.db` | `PREINSTALLED_RUNTIME` / `EXCLUDED` | 已 exclude |

**`skills/` 70.8 MB 是硬依赖，不是缓存**：其中 `odoo`(1.04 MB)、`odoo-19.0`(924 KB) 等 61 个技能是 Odoo Chatbot 的行为定义，装完 Hermes 也不会自动长出来。

---

## 3. 灾备包体积构成（现状 vs 目标）

以下数字全部来自 2026-11-24 真机 `du -sb` 与 P3 主备份 MANIFEST。

### 3.1 现状：8 条 extraPaths 里含 262 MB 纯日志

| extraPaths | 源体积 | 包内 zst | 其中应排除 |
|---|---|---|---|
| `vault` | — | 24,983,007 | `.git`（已排） |
| `web-cs` | 5,713,373,764 | 2,696,466 | `venv` 5.39 GB（已排）、`.git` 308 MB（已排） |
| `hermes-profile` | — | 6,106,023 | 已排 cache/logs/sessions/state.db |
| **`web-stack`** | **265,924,381** | **15,122,865** | **`sites/www.toogel.cn/log` 262,692,528（实际进了包！）** |
| `sys-units` | 9,278 | 5,190 | — |
| `hermes-home` | — | 34,182,091 | 已排 tools/profiles/cache/state.db |
| `attendance-system` | 2.1 MB（排 venv 后） | 806,403 | 已排 venv/db |
| `waf-data` | 41,268,433 | 38,900 | `geo` 27.9 MB（已排） |

**缺陷（本轮新发现，属我配置错误）**：`web-stack` 的 exclude 只写了 `./log`（tar 语义=**顶层**锚定），而日志实际在 `sites/www.toogel.cn/log/`（第二层）。实测 `tar --exclude=./log` 后成员里仍有 6 个 `log/` 条目，含 `access.log`(242,364,129 B) 与 `error.log`(20,330,227 B)。**262.7 MB 原始日志进了包**，压缩后 15.1 MB（access.log 压缩率 7.1%，因为重复度高）。

按新边界这类文件是 `EXCLUDED`。改为 `--exclude='*/log'` 后成员数 0。

### 3.2 目标体积

| 项 | 目标 |
|---|---|
| `web-stack` | ≤ 6 MB（只留 `conf.d/` 53 KB + `sites/*/{ssl,index}` 17 KB + WAF `sites/` 16 KB） |
| `waf-data` | 维持 38.9 KB（`geo` 已排、`db` 应排、`rules`/`default`/`html` 应排） |
| 总 extras | 从 83,095,642 B 降到约 **68 MB** |

---

## 4. WAF 的重新理解（用户明确要求）

v0.2.8 把 `1pwaf/data` 整目录作为一条 extraPath，只排除 `geo`。按新边界这是错的——它把"程序自带"和"运行状态"一起打包了。

### 4.1 `1pwaf/data` 七个子域的真机判定

| 子域 | 体积 | mtime | 判定 | 依据 |
|---|---|---|---|---|
| `sites/` | 15,964 | config.json 2026-06-23/08-01，rules 2026-06-22 | **`RESTORE_REQUIRED`** | 站点级 WAF 开关与逐项规则状态。虽然 18 个 rules 文件与全局逐字节相同，但**`sites/*/config.json` 是站点级策略**（`waf.state`/`mode`/每项 check 的 `on|off`/`code`/`action`），装完不会自动生成 |
| `conf/` | 6,002 | `global.json` 2026-06-22，`sites.json` 2026-11-12 | **`RESTORE_REQUIRED`** | 全局开关（实测 `waf.state=off`）、站点域名映射、`token`/`.secret`/`.aes_key` 三个密钥件 |
| `rules/` | 23,950 | **全部 2026-06-22**（与安装同秒） | **`PREINSTALLED_RUNTIME`** | 78 个文件，含 `vuln/` 57 个内置漏洞规则。自定义列表实测全 0 条目（`ipWhite`/`ipBlack`/`urlWhite`/`urlBlack`/`uaBlack`/`uaWhite`） |
| `default/` | 122,205 | **全部 2026-06-22** | **`PREINSTALLED_RUNTIME`** | 8 个文件，拦截页模板与默认配置 |
| `html/` | 128,619 | **全部 2026-06-22** | **`PREINSTALLED_RUNTIME`** | 10 个文件，CC 挑战页/拦截页/JS。无 `toogel`/`图狗` 定制痕迹 |
| `db/` | 1,359,872 | 多数 2026-06-23/07-31 | **`EXCLUDED`** | 71 个文件、55 个 sqlite，**总行数 389，全部在 `default.db`**（程序字典）；8 个事件库全 0 行 |
| `geo/` | 27,929,215 | 2026-06-22 | **`REBUILDABLE_DEPENDENCY`** | 3 个 mmdb，可由 1Panel 重新下载 |

### 4.2 由此得到的 WAF 备份策略

**只备份 `sites/` + `conf/`（合计 21,966 B），排除 `rules/`、`default/`、`html/`、`db/`、`geo/`。**

但有一个前提必须写进恢复流程：**`sites/*/rules/*.json` 与全局 `rules/` 逐字节相同（18/18）**，说明这些是"从全局复制过来的默认快照"。如果恢复时只还原 `sites/` 而不还原 `rules/`，而新装的 WAF 版本改了默认规则内容，则站点规则会**停留在旧版本内容**——这不一定是问题（站点级覆盖本来就该固定），但必须记录"这份快照对应的是哪个 WAF 版本"。

**实现方式**：`conf/waf.json` 里有 `{"name":"1Panel WAF","version":"2.0"}`，随 `conf/` 一起备份即可。

---

## 5. PostgreSQL 恢复清单（必须进报告，不只是备份）

主包 `dump.zip` 已含数据库与 filestore（实测 1,986 个 `filestore/` 条目、169 个模块清单）。但恢复成败取决于六项环境事实，**必须记录并在恢复时校验**：

| # | 项 | 实测值 | 恢复时校验动作 |
|---|---|---|---|
| 1 | PostgreSQL 版本 | `18.4`（`postgres:18.4-alpine`） | 预装同 major 版本；低版本无法 `pg_restore` 新版本 dump |
| 2 | 数据库 collate/ctype | `tg-odoo`: **`C`** / `en_US.utf8` | `createdb --lc-collate=C --lc-ctype=en_US.utf8 --encoding=UTF8`，**不能省略** |
| 3 | 角色 | `toogel`(super)、`tugou`(非 super) | 预建两个角色；主库 4025 个对象属主是 `tugou`、425 个是 `toogel` |
| 4 | 扩展 | `pg_trgm 1.6`、`plpgsql` | `postgres-contrib` 必须在镜像里；恢复前 `CREATE EXTENSION IF NOT EXISTS pg_trgm` |
| 5 | 非默认参数 | `listen_addresses=*`、`max_connections=100`、`shared_buffers=16384`(16 MB)、`log_min_duration_statement=5000` 等 18 项 | 逐项对照，`max_connections` 与 Odoo `db_maxconn=20`×4 进程 = 80 的关系必须成立 |
| 6 | 其他库 | 9 个库中只有 `tg-odoo` 有活动连接（`conns=3`），其余 8 个 `conns=0` | **明确记录"只恢复 `tg-odoo`"**，并列出其余 8 个库名作为"已知不恢复"清单 |

### 5.1 `--no-owner` 的后果要写清

`pg_dump --no-owner` 使 `dump.sql` 里 `OWNER TO` 出现 **0 次**。恢复后所有对象归**执行恢复的那个角色**。若目标环境用不同角色名连库，Odoo 的权限检查可能因对象属主不匹配而失败。因此：

- **恢复必须用与生产相同的角色名**（`tugou` 或 `toogel`）；
- 或在恢复后执行 `REASSIGN OWNED BY <恢复时角色> TO tugou`；
- 两条路必须在恢复清单里写明选哪条。

---

## 6. Discovery 输出要求

### 6.1 每条记录的字段

在现有 `path`/`sources`/`confidence`/`coverage`/`coverageReason`/`recoveryRisk`/`absorbed`/`category` 之外，新增：

```js
{
  disposition: 'PREINSTALLED_RUNTIME' | 'RESTORE_REQUIRED' | 'REBUILDABLE_DEPENDENCY' | 'EXCLUDED',
  dispositionReason: string,       // 为什么这么判，必须能被人复核
  rebuild: null | {                // 仅 REBUILDABLE_DEPENDENCY
    how: string,                   // 重建命令或步骤
    source: string,                // 下载地址 / 包名
    version: string,               // 版本或 digest
    verify: string,                // 校验方式
  },
  preinstall: null | {             // 仅 PREINSTALLED_RUNTIME
    name: string,                  // 1Panel / PostgreSQL / OpenResty / Hermes / WAF
    version: string,
    image: string | null,          // 容器镜像 + digest
    source: string,                // 安装来源
  },
}
```

**硬约束**：`disposition !== 'RESTORE_REQUIRED'` 的条目**永远不进 `suggest`**。它们进一个新档 `inventory`（清单），供人查阅，但不制造"待办"。

### 6.2 报告结构变化

报告头必须新增一行：

```
职责分布：恢复业务状态 N 条 / 预置运行环境 N 条 / 可重建依赖 N 条 / 已排除 N 条
```

正文四档不变（`covered`/`suggest`/`confirm`/`overflow`），但 `suggest` 的语义收窄为「**`RESTORE_REQUIRED` 且未覆盖**」。新增一节：

```
## 预置运行环境清单（不需要备份，但恢复前必须装好）
```

每条给 `name` / `version` / `image` / `source`，让人能照着把环境装出来。

新增一节：

```
## 可重建依赖清单（不备份，但必须照此重建）
```

每条给 `how` / `source` / `version` / `verify`。

### 6.3 `MAX_EXTRAS` 的语义不变

`MAX_EXTRAS=8` 仍只限制"能写进配置的 extraPaths 条数"。按新边界，`RESTORE_REQUIRED` 的目录数应该**显著少于** 8 条——如果发现超过 8 条 `RESTORE_REQUIRED`，说明边界判定有误，应该先复查分类而不是扩容量。

---

## 7. 本轮盘点发现的三个实际错位

| # | 错位 | 证据 | 处置 |
|---|---|---|---|
| 1 | `web-stack` 把 262.7 MB 运行日志打进包 | `tar --exclude=./log` 后仍有 `sites/www.toogel.cn/log/access.log`(242 MB)、`error.log`(20 MB)；包内 15,122,865 B | exclude 改 `'*/log'`，并加 `'*/index'`（Odoo 静态副本可重建） |
| 2 | `waf-data` 把 251 KB 程序自带资源 + 1.36 MB 运行状态打进包 | `rules/`/`default/`/`html/` 全部 mtime 2026-06-22（安装同秒）；`db/` 389 行全是程序字典 | 改为只备 `sites/` + `conf/`（21,966 B） |
| 3 | `hermes-home` 未排除 `.env`（25 个键含 8 个密钥类） | `tar` 成员里有 `./.env` 与 `./auth.json` | `.env` 保留（Agent 配置依赖），但必须在报告里标为「含密钥，仅加密包」；`auth.json` 是 OAuth token，同样标 |

第 3 项与 v0.2.8 的 `hermes-profile/.env` 处置不一致：profile 的 `.env` 被排除、home 的 `.env` 被包含。按新边界，Agent 运行依赖的环境变量属 `RESTORE_REQUIRED`，**应该包含**；但 profile 与 home 两个 `.env` 的关系必须查清并写进文档（当前 profile 的 `.env` 有 `QQ_APP_ID`/`QQ_CLIENT_SECRET`/`DEEPSEEK_API_KEY`，home 的 `.env` 有 25 个键含 `ODOO_PASSWORD`）。

---

## 8. 验收判据

| # | 判据 | 验证方式 |
|---|---|---|
| RB-1 | 每个发现项都有 `disposition`，且四类计数之和 == 发现总数 | 单测 + 真机 |
| RB-2 | `suggest` 中不含任何 `disposition !== 'RESTORE_REQUIRED'` 的条目 | 单测 + 真机 |
| RB-3 | `PREINSTALLED_RUNTIME` 项在报告中出现在「预置运行环境清单」，含 version/image/source | 单测 |
| RB-4 | `REBUILDABLE_DEPENDENCY` 项含 `how`/`source`/`version`/`verify` 四项非空 | 单测 |
| RB-5 | `1pwaf/data` 子树中 `rules`/`default`/`html`/`db` 判 `PREINSTALLED_RUNTIME` 或 `EXCLUDED`，`sites`/`conf` 判 `RESTORE_REQUIRED` | 真机 |
| RB-6 | `web-stack` 包内成员 `log` 命中 0 | 真机打包核对 |
| RB-7 | PostgreSQL 恢复清单六项全部有实测值，且 `db/` 被排除 | 真机报告 |
| RB-8 | 报告头含「职责分布」行，四类计数与正文一致 | 单测 |
| RB-9 | `/opt/1panel` 平台本体（11.85 GB）不在任何 extraPaths 内，且判 `PREINSTALLED_RUNTIME` | 真机 |
| RB-10 | 边界判定不影响 `RESTORE_REQUIRED` 的召回：`attendance-system`、`web_cs`、`vault`、`hermes-home` 业务数据仍判 `RESTORE_REQUIRED` | 真机 |

---

## 9. 明确不做

- 不改 `MAX_EXTRAS` 上限
- 不自动修改 extraPaths（本规格只定义判定，配置改动需单独批准）
- 不把 `PREINSTALLED_RUNTIME` 的安装脚本打包（只记录 version/source，让人重新装）
- 不做数据库物理级备份（`db/` 与 pg `data/` 都排除，靠逻辑导出）
- 不恢复 1Panel 平台本体
- 不改 WAF 的 `global.waf.state`（仍为 `off`，是上一个决策的待裁决项）

---

## 10. 预装清单（m07836 第 3 项裁决的固化）

用户裁决原文要点：「预先安装运行环境，灾备恢复业务状态；**依赖必须有明确版本和恢复依据，不能只保证文件存在，却无法保证服务重新运行。**」

### 10.1 分类与裁决

| 项目 | 正式归类 | 裁决 |
|---|---|---|
| `python3.12-venv` | 操作系统预装依赖 | **纳入预装清单** |
| `attendance/requirements-full.txt` | 应用级完整依赖声明 | **纳入恢复清单** |
| `attendance/requirements.txt` | 基础依赖声明 | 保留（不作恢复依据） |
| `web-cs-requirements.lock` | 应用级依赖版本快照 | **纳入灾备**（v0.3.1 实现，见 §10.3） |

### 10.2 为什么 `python3.12-venv` 必须预装

真机证据（测试机 2026-11-24）：`/usr/bin/python3 -m venv venv` 报

```
The virtual environment was not created successfully because ensurepip is not available.
ModuleNotFoundError: No module named 'ensurepip'
```

`apt-get install -y python3.12-venv` 后 `install_rc=0`、`ensurepip OK`，同一命令成功。

**没有它，任何「按依赖声明重建 venv」的恢复步骤都走不通**，而这是恢复 attendance 与 web_cs 两个服务的必经之路。因此它是**基础设施负责提前准备**的一项，不是灾备包的内容。

v0.3.1 的 `buildDepsRestoreScript` 在命中 `ensurepip` 时输出
`DREST_HINT=宿主机缺少 python3-venv（Debian/Ubuntu 为 python3.12-venv）…`，把排查方向直接指到这条。

### 10.3 为什么 attendance 必须用 `requirements-full.txt`

`app.py:26` 有 `from weasyprint import HTML`，而 `requirements.txt` 只有四个包
（`Flask==3.0.3 / gunicorn==22.0.0 / Werkzeug==3.0.3 / Flask-Session==0.8.0`）。

真机后果：gunicorn worker 报 `ModuleNotFoundError: No module named 'weasyprint'` /
`Worker failed to boot`。改用 **`requirements-full.txt`（32 个包，含 `weasyprint==69.0`）**
后 `weasyprint OK 69.0`，`/login` 200、`/dashboard` 302。

→ **`weasyprint` 不能当可选依赖。** 一个「装了四个包就能跑」的假设，会让恢复出的
attendance 服务在第一次打印报表时崩掉，而登录页看起来是好的。

### 10.4 web_cs 依赖快照（v0.3.1）

`/opt/web_cs` 生产上有 65 个已安装 Python 包，却**没有任何依赖声明文件**
（`requirements.txt` / `requirements-full.txt` / `pyproject.toml` / `setup.py` / `Pipfile` 全 404）。
恢复源码与配置后 `webchat.service` 起不来：`Command /opt/web_cs/venv/bin/python3 is not executable`。

v0.3.1 新增 `depsLocks` 配置，备份时在生产 venv 上跑 `pip freeze`，产出
`web-cs-requirements.lock`，随加密主包带走。锁文件记录 8 行头：

```
# dsh-odoo-backup deps lock v1
# name: web-cs
# venv: /opt/web_cs/venv
# python: 3.12.3          ← 精确解释器版本，缺了就无法判断能否重建
# pip: 24.0
# generated: 2026-11-24T13:14:38Z
# packages: 65
# note: pip freeze 是依赖版本快照，不是离线安装介质；PyPI 下架该版本时仍需另行取证（wheel 存档）。
# restore: python3 -m venv <target> && <target>/bin/pip install -r <this file>
```

**边界（用户原话）**：`pip freeze` 是版本快照，**不是完整的离线安装介质**。PyPI 下架某版本时
单有快照仍装不上 → 暂时记录版本与来源即可，关键依赖再考虑存 wheel；**不把整个 65 包 venv 打进包**。

### 10.5 恢复验收方式（用户要求）

1. 建临时 venv，按锁文件 `pip install -r`；
2. **对比安装后 `pip freeze` 与锁文件**（missing 与 extra 都要报，多装的包会改变行为）；
3. 执行服务启动测试。

真机已按此验证（测试机 `/root/attendance-system/venv`，34 包 / 951 B / Python 3.12.3）：
重建后 `pip freeze` 与锁文件 **34 / 34 完全相同，`diff` 为空**。

---

## 11. 变更记录

| 日期 | 版本 | 变更 |
|---|---|---|
| 2026-11-24 | 1.0 | 初版。定义四分类、职责表、`1pwaf/data` 七子域判定、PostgreSQL 六项恢复清单、三个实际错位、RB-1~RB-10 验收判据 |
| 2026-11-24 | 1.1 | 新增 §11 预装清单：固化 m07836 第 3 项裁决（`python3.12-venv` 纳入预装、`requirements-full.txt` 纳入恢复清单、`web-cs-requirements.lock` 纳入灾备），含 v0.3.1 依赖快照机制与真机验收证据 |
