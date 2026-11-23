# External Service Discovery — 设计规格

> 状态：设计定稿，待实现
> 基线：`dsh-odoo-backup` v0.2.5（`@local/dsh-odoo-backup`，已装于 `C:\Users\Ho\.dsh\profiles\desktop\node_modules\@local\dsh-odoo-backup`）
> 目标版本：v0.3.0（新增能力，不改动现有备份/恢复核心）
> 日期：2026-11-23
> 相关：`2026-11-23-chatbot-dr-coverage-and-rag-index.md`（L1/L2/L3 已执行完毕）

## 0. 一句话结论

给插件加一个**只读的外部依赖发现能力**：以现有 `lib/discover.js` 为入口，联合 Odoo 模块、运行时进程、容器挂载、systemd unit 四类证据，算出「哪些外部服务的数据目录还没进灾备」，产出一份**带证据、带置信度、带容量告警**的差异报告；用户确认后才写 `extraPaths`。

## 1. 为什么需要（问题定义）

v0.2.5 的 `extraPaths` 是**手工配置**的。2026-11-23 的实测暴露了手工配置的系统性缺陷：

- 第一轮只配 1 条 `vault`，漏了 `web_cs`、`hermes`、`nginx`、`systemd units`。
- 第二轮补到 6 条，但 L2 辅助脚本又只挑了 `/root/scripts/kb`，漏了 `odoo19-website-translator/` 412,897 B、`toogel/` 58,432 B、`toogel-v20/` 42,627 B。

**根因不是粗心，而是没有对账机制**：配置对不对，只能靠人回忆「系统里还跑着什么」。Odoo 能告诉插件装了哪些模块，但**不能告诉插件这些模块在容器外调用了哪些服务、数据落在哪个目录**。

## 2. 现状盘点（写规格前必须确认的事实）

| 项 | 事实 | 对本规格的约束 |
|:--|:--|:--|
| 已有发现能力 | `lib/discover.js` 已能发现：容器名/镜像/`odooVersion`/`dbName`（含 `dbfilter` 推断，confidence=high）/`addonsPath`/`dataPath`/`pydepsPath`/`confPath`/`uid`/`gid`/`httpEndpoint`/`pgContainer`/`pgSuperUser`/全部数据库列表 | **复用，不重写**；只需在其输出上追加外部服务维度 |
| 配置容量 | `lib/extra-paths.js:14` `MAX_EXTRAS = 8`；当前已用 6 条 | 报告必须有「超限」档；上限必须可配、**不能固化进发现逻辑** |
| 路径校验 | `validateExtraPath` 要求绝对路径、非 `/`、无 `..`、无换行、长度 ≤512；远端 `[ -d "$SRC" ]` 要求**必须是目录** | 发现结果只能产出目录；单文件走 L2 辅助脚本，不进 `extraPaths` |
| 备份执行链 | `runBackup` → `packExtras` → `buildExtraPackScript`，fail-closed（任一额外路径不存在即整次备份 throw） | 发现的路径**必须先验证存在+可读**再建议，否则会让主备份整体失败 |
| 远程执行 | `lib/ssh.js:149-234` `execRemote(server, script, {stdin, timeoutMs, maxBuffer})`，脚本 base64 进 argv，stdin 空闲供 `read` | 扫描统一走这个通道，**不新增 SSH 通路** |
| 静态扫描的可靠性 | 2026-11-23 实测：正则扫 `server.py` 把 `_call_hermes`（降级兜底）误判为主路径；另一处 `[\s\S]*?` 正则把 service.js 从 565 行改塌到 294 行 | **代码扫描只能作低置信度线索，不能单独产出路径建议** |

## 3. 设计原则（三条不可妥协）

1. **以运行环境为准，不以模块名称为准。** 模块清单只是入口；实际进程、挂载、工作目录才是灾备依据。
2. **以持久化数据为对象，不以服务进程为对象。** 发现 Docker 容器不等于要备份整个容器卷；要看它把数据落在哪里。
3. **自动发现，人工确认，自动维护。** 扫描永不直接写配置；只有用户勾选的路径才进 `extraPaths`。

补充两条来自本项目实测的硬约束：

4. **容量上限不能成为发现能力上限。** `MAX_EXTRAS=8` 限制的是「写入」，不是「可见」。超限的发现必须完整列出。
5. **fail-closed 是双刃剑。** 由于 `packExtras` 遇到不存在的路径会让整次备份失败，发现流程必须**在任何路径进入配置前**完成存在性、可读性、目录性三重验证。

## 4. 四层扫描（证据优先级递减）

### L1-odoo：Odoo 模块与配置（证据强度：高）

| 子项 | 来源 | 产出 |
|:--|:--|:--|
| 已安装模块 | `SELECT name, latest_version, state FROM ir_module_module WHERE state='installed'` | 自定义模块清单（需按 `addonsPath` 白名单过滤掉 Odoo 官方模块） |
| 模块依赖 | 每个模块 `__manifest__.py` 的 `depends` | 功能依赖链 |
| 外部依赖声明 | `external_dependencies`（python/bin） | 运行时依赖，**不含数据目录** |
| 系统参数 | `ir_config_parameter` 中键名含 `path`/`dir`/`url`/`host`/`endpoint`/`token` 的项 | 疑似外部服务地址或路径（**值需脱敏，只留键名与形状**） |
| 附件存储 | `ir_attachment` 的 `store_fname` 前缀统计 | 确认 filestore 在 `dataPath` 内（现有 backuppipeline 已覆盖） |

**过滤规则**：`addonsPath` 下的目录名 + `name in ('base','web','website',...)` 官方前缀 → 排除；只保留真正第三方模块。

**实测样例（toogel，2026-11-23）**：`ir_module_module` 共 727 条、`installed` 169 条；其中自定义 26 个（`ai_translation_gateway` `chatbot_ai_hermes` `logistics_tracking` `payment_china` `sms_alibaba` `toogel_china_map` `tugou_*` ×8 `website_*` ×7 `patches` `tools` 等）。

### L2-config：配置与代码（证据强度：中—低）

| 子项 | 来源 | 产出 | 置信度 |
|:--|:--|:--|:--|
| 环境变量引用 | 模块内 `os.environ` / `os.getenv` 键名 | 该模块依赖哪些外部配置 | 中 |
| URL 字面量 | `http(s)://...` 正则 | 疑似外部服务地址 | 中 |
| **路径字面量** | 形如 `/opt/...` `/root/...` 的绝对路径字符串 | **疑似数据目录** | **低** |

**硬约束**：L2 **不产出**可直接写入 `extraPaths` 的建议，只作为「线索」列在报告附注里，必须与 L3/L4 的运行时证据交叉命中才升级为建议。

理由：2026-11-23 实测中，静态扫描把 `_call_hermes_legacy`（实际只在 `DEEPSEEK_API_KEY` 为空时降级走到）误判为主链路，导致知识库文档写错、需要返工修正。

### L3-runtime：进程与容器（证据强度：高）

| 子项 | 命令 | 产出 |
|:--|:--|:--|
| 容器清单 | `docker ps -a --format '{{.Names}}\t{{.Image}}\t{{.Status}}'` | 全部容器 |
| 容器挂载 | `docker inspect <c> --format '{{json .Mounts}}'` | `Source`→`Destination` 映射（这是**最硬的路径证据**） |
| 容器环境 | `docker inspect <c> --format '{{json .Config.Env}}'` | 键名（值脱敏） |
| 容器工作目录 | `docker inspect <c> --format '{{.Config.WorkingDir}}'` | 服务根目录 |
| 监听端口 | `ss -lntp` 或 `docker port` | 服务对外形态 |
| 宿主进程 | `ps -eo pid,user,args --no-headers` | 非容器化服务（如 `webchat.service`、`hermes gateway`） |

### L4-systemd：服务单元（证据强度：高）

| 子项 | 命令 | 产出 |
|:--|:--|:--|
| 全部 unit | `systemctl list-units --type=service --state=running --no-pager` | 运行中服务 |
| 单元详情 | `systemctl cat <unit>` | `WorkingDirectory` / `EnvironmentFile` / `ExecStart` |
| 启用状态 | `systemctl is-enabled <unit>` | 开机自启（决定恢复时是否必须重建） |
| cron | `crontab -l`、`/etc/cron.d/*`、`/root/.hermes/cron/jobs.json` | 定时任务脚本路径 |

**`WorkingDirectory` + `EnvironmentFile` 是最有价值的一对证据**：前者直接给出服务的数据根，后者给出配置根。

## 5. 归并与对账（核心逻辑）

```
候选路径集 P = L3挂载源 ∪ L3进程cwd ∪ L4 WorkingDirectory ∪ L4 EnvironmentFile目录 ∪ L2高置信线索
                          ↓
              去重（规范化 + 父子路径折叠：保留最上层，标注「已包含 N 个子路径」）
                          ↓
        与三条既有覆盖线对账：
          ① extraPaths 现有条目（含 exclude 语义）
          ② 主备份固定范围（dump.zip / addonsPath / pydepsPath / odoo.conf）
          ③ L2 辅助脚本范围（/etc/cron.d 选定文件、jobs.json、kb_mail.env、
              /root/.local/bin 4 个 wrapper、2 个 unit、/root/scripts 全树）
                          ↓
              分类：已覆盖 / 建议新增 / 待确认 / 超限 / 已排除（含理由）
```

### 分类判据

| 分类 | 判据 |
|:--|:--|
| **已覆盖** | 规范化后路径等于或位于某个 `extraPaths` 的 `path` 之下，且未被其 `exclude` 排除；或命中主备份固定范围 |
| **建议新增** | 未覆盖；且 `[ -d ]` 通过；且 `[ -r ]` 通过；且不匹配任何「应排除」特征（见 §6） |
| **待确认** | 未覆盖；但 ① 存在性/可读性验证失败，或 ② 体积超阈值，或 ③ 置信度来自 L2 单源 |
| **超限** | 归入「建议新增」但导致总数 > `MAX_EXTRAS` |
| **已排除** | 命中排除特征（缓存/临时/日志/密钥策略），记录排除理由 |

### 每条发现的记录结构

```
{
  name:        string          // 建议的 extraPaths name（合法化后）
  path:        string          // 绝对路径
  kind:        'dir'
  bytes:       number | null   // du -sb 结果；不可测为 null
  evidence: [                  // 证据链，至少一条
    { layer: 'L3-mount',  source: 'docker inspect webchat-container .Mounts[0].Source' },
    { layer: 'L4-systemd', source: 'webchat.service WorkingDirectory=/opt/web_cs' }
  ],
  confidence: 'high' | 'medium' | 'low',
  relatedModules: string[],    // 关联的 Odoo 模块名
  service:     string,         // 服务名（容器名 / unit 名 / 进程名）
  status:      'covered' | 'suggest' | 'confirm' | 'overflow' | 'excluded',
  coverage:    'main' | 'extraPaths' | 'l2' | 'none' | 'unverified',   // 见 §5.1
  reason:      string,         // status 的判定理由（中文，给用户看）
  suggestedExclude: string[]   // 建议的 exclude（如 ['./venv','./cache']）
}
```

### 5.1 `covered` 的五态（用户 2026-11-23 追加要求）

「目录出现在备份清单里」**不等于**「相关功能可以完整恢复」。因此 `covered`（以及任何进入备份范围的路径）必须带 `coverage` 标记，五态互斥：

| `coverage` | 含义 | 判据 | 用户的行动 |
|:--|:--|:--|:--|
| `main` | 已被主备份固定范围覆盖 | 位于 `addonsPath` / `dataPath` / `pydepsPath` / `odoo.conf` 之内 | 无需动作 |
| `extraPaths` | 已被某条 `extraPaths` 覆盖 | 规范化后位于其 `path` 之下，**且未被该条目的 `exclude` 排除** | 核对 exclude 是否漏排（如 `./scripts/__pycache__` 那类） |
| `l2` | 已被 L2 独立脚本覆盖 | 位于 `kb/` / `ops/` 打包范围，或属 11 个单文件清单 | **不在主包内**，恢复时需单独取回 |
| `none` | 已发现但**完全没备份** | 不命中以上任一 | 决定是否加进 `extraPaths` |
| `unverified` | 已备份但**恢复方式未验证** | 命中 `l2` 或 `extraPaths`，但该项含「恢复时需重建/联网下载/轮换密钥」的资产 | 恢复演练时必须单独验证 |

关键区分：

- `l2` ≠ `main`：L2 产物在 `/srv/backups/aux` 与本机 `K:\Backup\odoo\aux`，**不在加密主包里**，恢复时是两条独立路径。
- `unverified` 是叠加在 `l2`/`extraPaths` 之上的**风险标记**，不是替代。报告里用 `coverage=l2` + `recoveryRisk: [...]` 同时表达。
- 报告头除四档计数外，**必须再给一行 `coverage` 分布**（`main N / extraPaths M / l2 K / none X / unverified Y`），否则「都覆盖了」会变成一句无信息的话。

### 5.2 模块 → 服务 → 六类资产（用户 2026-11-23 追加要求）

发现结果不能只是「一堆目录」。每条链路必须能回答「这个模块依赖的服务和数据能不能一起恢复」。因此报告包含一个 **dependency graph**，每条边是：

```
Odoo 模块 (module)
  └── 外部服务 (service)
       ├── 服务配置      config      // systemd unit / EnvironmentFile / conf.d / odoo.conf
       ├── 持久化数据    data        // state.db / query_log.db / 业务库
       ├── 文件目录      files       // WorkingDirectory / Mounts.Source
       ├── 数据库        db          // pg 容器内的库（+ 是否在主包 pg_dump 内）
       ├── API/连接      api         // 对外/对内的 endpoint（**只记键名与形状，不记值**）
       └── 恢复方式      recovery    // 重装/重建索引/联网下载/轮换密钥
```

实现约束：

- **关联强度分级**：`explicit`（模块代码直接引用服务名/URL/路径，静态可读）> `inferred`（按命名或部署共现推断）> `unknown`。报告必须标出来源，不可把 `inferred` 写成确定事实。
- **`api` 类只输出键名与 URL 形状**（如 `DEEPSEEK_API_KEY`、`https://api.deepseek.com/v1/...`），**永不输出值**。这与 AC-7 是同一件事的两面。
- **`recovery` 是必填字段**，不允许留空。没有恢复方式说明的资产 = 未知风险，写 `未知（需人工确认）`。
- 六类里缺哪类，报告显式写「未发现」，不省略行——省略会让人误以为不存在。

### 5.3 本轮只做 Phase 1（用户 2026-11-23 明确边界）

不重构备份核心、不提前实现自动写入、不增加审核阶段。发现结果**只读**，写配置留到 Phase 2 且需显式确认。

## 6. 排除特征（不进建议，但仍入报告）

| 类别 | 特征 | 处理 |
|:--|:--|:--|
| 缓存 | `cache`/`.cache`/`__pycache__`/`node_modules`/`.pytest_cache`/`tmp`/`temp` | 作为子孙被包含时，自动加进 `suggestedExclude` |
| 日志 | `log`/`logs`/`*.log` | 同上 |
| 版本控制 | `.git` | 同上（除非该目录是唯一副本，如 `odoo19-website-translator/.git`） |
| 虚拟环境 | `venv`/`.venv`/`env` | 同上；记录「恢复时需重建」 |
| 模型权重 | `huggingface`/`models--*`/`*.safetensors`/`*.bin` | **不入包**，报告标注「恢复时联网下载」 |
| 密钥文件 | `.env`/`*.pem`/`*.key`/`id_rsa*`/`credentials*` | 单独列为「密钥类」，走独立提取策略，**不混在普通路径里** |
| 过宽路径 | `/root`、`/`、`/var`、`/var/lib/docker`、`/usr` | **永不建议**，报告标「范围过宽」 |

## 7. 容量上限的处理

`MAX_EXTRAS` 从 `lib/extra-paths.js` 常量改为**可读配置**（默认仍 8），发现逻辑只读不写：

- 报告头固定四档计数：`建议新增 N / 已覆盖 M / 待确认 K / 超出容量 X`。
- **X > 0 时，报告必须完整列出全部超限项**，不得截断。
- 报告中给出「按体积/按证据强度」两种排序建议，让用户自己取舍。
- 不提供「自动删减到 N 条」的能力——那会把决策的后果隐藏起来。

## 8. 两阶段落地

### Phase 1：只读扫描 + 覆盖对账（本规格实现范围）

- 新增 `lib/discovery/` 模块，**不侵入** `lib/backup.js` / `lib/service.js` / `lib/extras-runner.js`。
- 新增工具 `odoo_backup action=scanExternalDeps server=<name>`，只读，返回上文的报告结构。
- 新增 GUI 入口：服务器卡片内「扫描外部依赖」按钮 → 结果面板 → 勾选 → 写 `extraPaths`（复用现有 `POST /odoo-backup/save-servers`）。
- **不新增后端路由**：写入仍走 `save-servers`（整数组写回，未知字段保留）。

### Phase 2：确认后自动维护

- 保存「已确认」与「已忽略」两组决策，下次扫描时对比，只提示**新增**的差异。
- 提交前对每条路径做三重校验（存在/可读/目录）。
- 提供 `dry-run`：显示「即将写入的 6 条」与「将被替换的 1 条」，需显式确认。

## 9. 错误与降级

| 情况 | 行为 |
|:--|:--|
| 远端无 `docker` | L3 全部跳过，报告标注「容器层不可用」，L1/L4 照常 |
| 远端无 `systemctl` | L4 跳过，报告标注 |
| Odoo 容器无法 `psql` | L1 退化为「只扫描 addonsPath 目录名」，confidence 降为 medium |
| 某条路径 `du` 超时 | `bytes: null`，status 保持 `suggest`，但 reason 标注「体积未知」 |
| 扫描整体超时 | 返回已完成部分 + `partial: true` + 未完成层清单；**不得返回空报告冒充成功** |
| `MAX_EXTRAS` 已满 | 报告正常产出，全部归入 `overflow`，附「需先释放容量」提示 |

## 10. 验收判据

| 判据 | 期望 |
|:--|:--|
| AC-1 | 在 toogel 上扫描，`/opt/web_cs`、`/root/.hermes/profiles/cs-main`、`/opt/1panel/www`、`/etc/systemd/system`、`/root/.hermes` 五条分别被判定为 `covered`（因为它们已在 `extraPaths` 里），且 `coverage === 'extraPaths'` |
| AC-2 | `/root/scripts/odoo19-website-translator`、`/root/scripts/toogel`、`/root/scripts/toogel-v20` 被判定为 `covered`，`coverage === 'l2'`，reason 引用 L2 覆盖线（`ops-scripts` 包） |
| AC-3 | 人为造一个未覆盖目录（如 `/opt/test-svc`，由临时 systemd unit 指向），扫描后必须出现在 `suggest` 且 evidence 含 `L4-systemd` |
| AC-4 | 报告头四档计数之和等于发现总数（无静默丢弃）；`coverage` 五态计数之和同样等于总数 |
| AC-5 | 把 `MAX_EXTRAS` 临时设为 3，报告仍列出全部发现，超出的归入 `overflow` |
| AC-6 | 扫描过程零写入：`extraPaths`、生产文件、systemd 状态均不变（用前后 SHA-256 对比） |
| AC-7 | 扫描输出中不出现任何 `.env` 的值、任何 token 值（用 grep 已知密钥串验证 0 命中） |
| AC-8 | **`coverage` 五态全部有真实样例**：toogel 上必须能同时看到 `main`（`addonsPath`）、`extraPaths`（`/opt/web_cs`）、`l2`（三个 scripts 目录）、`none`（至少一个未覆盖项）、`unverified`（含「恢复时需重建」的资产） |
| AC-9 | **dependency graph 每条边六类资产齐全**：缺哪类显式写「未发现」，不得省略行；`api` 类只出现键名与 URL 形状，不出现值 |
| AC-10 | **静态扫描不得单独产出 `suggest`**：构造一个只在代码里出现、运行时无任何证据的路径，其结果必须停在 `confirm` 或 `excluded`，且 evidence 只有 L2-config |

## 11. 明确不做（避免范围蔓延）

- 不改 `lib/backup.js` 的打包流程。
- 不改 `extraPaths` 的校验规则（仍是目录、仍 fail-closed）。
- 不自动重启/停止任何服务。
- 不自动修改 `extraPaths`（Phase 2 也需显式确认）。
- 不备份 Docker 镜像、模型权重、数据库数据目录（数据库走 `pg_dump`，已在主流程内）。
- 不引入新依赖（`discovery/` 只用 Node 内置 + 现有 `ssh.js`）。

## 12. 与既有机制的关系

| 机制 | 关系 |
|:--|:--|
| `lib/discover.js` | **复用**：扫描第一层直接调用它，拿容器/路径/库名 |
| `lib/extra-paths.js` | **复用**：用 `validateExtraPath` / `normalizeExtras` 校验建议值；`MAX_EXTRAS` 改为可配 |
| `lib/extras-runner.js` | **不动**：扫描不触发打包 |
| `lib/service.js` | **不动**：只在 `apply` 里注册新工具 |
| L2 `aux-snapshot.sh` | **纳入对账**：扫描要知道 L2 覆盖了哪些（当前 11 个单文件 + `kb/` + `ops/` 三目录） |
| `rag-backup` / `vault-sync` | **不改**：只在报告里标注「已有独立周备份，与主包不互通」 |
