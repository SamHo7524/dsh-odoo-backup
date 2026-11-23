# Odoo Chatbot 灾备全覆盖 + Dense 索引重建 — 实施计划

> 基线：插件 **v0.2.5**（本机 profile 运行中，`extraPaths` 已上线并真机验证）。
> 目标：换新机能完整跑起 Odoo + chatbot（含 KB 检索与 RAG），并把「Dense 索引已过期 3.7 个月」这个静默劣化修掉。
> **本计划不升插件版本号**：覆盖率扩展走既有 `extraPaths` 配置 + 一个独立辅助脚本；索引重建是运维动作。
> 依据：2026-11-23 实测（用户 m02902 逐条把关后二次修订）。

---

## 0. 结论先行

三件事，按风险从低到高：

| 层 | 做什么 | 改代码？ | 需要批准？ |
|:--|:--|:--|:--|
| **L1 覆盖率** | 在 GUI 给 toogel 增配 5 条 `extraPaths`（共 6 条，`MAX_EXTRAS=8` 留 2 条余量） | 否 | 否（只改配置） |
| **L2 单文件补齐** | 新增独立辅助脚本，把 `/etc/cron.d/*`、`/root/scripts/kb`、若干散文件打成小包 | 新增脚本（不动插件） | 否 |
| **L3 索引重建** | `cp -a` 备份 → 跑 `build_embeddings.py` → **单独申请重启** → 重启后验证 | 否 | **是（重启 webchat）** |

三层之间无依赖，可分别验收。

---

## 1. 口径修正（相对 2026-11-23 初版报告）

用户 m02902 指出四处数字 + 一处执行逻辑问题，逐条实测结论：

| # | 初版写法 | 实测结论 | 处理 |
|:-:|:--|:--|:--|
| 1 | 「15 个文件 Dense 层召回不到」 | **高估**。`build_embeddings.py:75-89` 的规则：`EXCLUDE_DIRS = {'00-计划与方案','assets','07-内部资料'}` 排 3 篇，`index.md`/`README.md` 排 9 篇 → 磁盘 52 篇里**可索引 40 篇**；索引含 37 篇 → **真实业务缺口 3 篇 / 30 chunks** | 采纳 |
| 2 | 「索引后改过 23 个」 | 方向对但口径要换：**已索引的 37 篇里 12 篇被改过，涉及 156/458 chunks = 34.1%**。重建收益大头是纠正陈旧内容，不是补 3 篇 | 采纳（「15」全部改成「3 篇 + 12 篇陈旧」） |
| 3 | 验收判据「37→52」 | **错**。重建结果 = **40 文件 / 496 chunks**。用 52 当判据会把成功误判为失败 | 采纳 |
| 4 | 模型权重「781 MiB 单份」 | **初版对，用户的双份判断被推翻**：`du -sb` = 818,815,474 B；两个 snapshot（`refs/main` 的 `pytorch_model.bin`、`refs/refs/pr/1` 的 `model.safetensors`）**共用同一批 blob**，目录内 12 个 blob 合计 818,814,719 B。1.56 GiB 是把两个大文件表观尺寸相加的重复计数 | 保留 781 MiB |
| 5 | 「重建后立刻验证」 | **错**。`_DENSE_RETRIEVER = DenseRetriever()` 是 `server.py:1536` **模块级单例**，`_load()`（`:405-425`）在构造时把索引读进内存 → 重建磁盘文件不影响运行中进程，**必须 `systemctl restart webchat`**；且 `:422-425` 日志**只打印 chunks 数与维度、不打印 `file_count`** | 采纳，改为 5 步 SOP |

另有一处需要澄清对方的断言：「插件里根本没有 `extraPaths`、版本是 0.2.0」——**那是服务器上的旧源码树** `/root/dsh-odoo-backup`（0.2.0，零命中）。**运行主体是本机 profile 的 v0.2.5**，`lib/extra-paths.js` / `lib/extras-runner.js` / `lib/local-space.js` 齐全，`extraPaths` 命中 7 个文件，且已真机备份出 `vault-20261121-181236.tar.zst`（24,982,343 B）。

---

## 2. 体积预算（2026-11-23 实测 `du -sb`）

| 层 | 条目 | 字节 | 人类可读 |
|:--|:--|--:|--:|
| L1-1 | `/opt/web_cs`（排 `venv/.git/__pycache__/backups`） | 8,704,413 | 8.30 MiB |
| L1-2 | `/root/.hermes/profiles/cs-main`（排 `cache/.git/logs/sessions/state.db*/bin/models_dev_cache.json`） | 37,332,256 | 35.60 MiB |
| L1-3 | `/opt/1panel/www`（排 `log/index`） | 64,613 | 63.10 KiB |
| L1-4 | `/etc/systemd/system`（全目录，无法只挑单文件） | 9,278 | 9.06 KiB |
| L1-5 | `/root/.hermes`（**排 `profiles`**，因 L1-2 已覆盖 cs-main；再排 tools/cache/node/installs/lsp/bin/state-snapshots/logs/sessions/plugins/各类 db/缓存） | **85,688,320** | **81.72 MiB** |
| L1-6 | `/root/Documents/Obsidian Vault`（已配，排 `./.git`） | 未压缩 116,500,892 / 包内实测 24,982,343 | 111.0 / 23.8 MiB |
| **L1 小计** | 六条额外路径未压缩合计 | **248,299,772** | **236.78 MiB** |
| L2-1 | `/etc/cron.d` | 1,190 | 1.16 KiB |
| L2-2 | `/root/scripts/kb` | 331,581 | 323.81 KiB |
| L2-3 | `/root/.hermes/cron/jobs.json` | 23,238 | 22.69 KiB |
| L2-4 | `/root/.hermes/secrets/kb_mail.env` | 267 | 267 B |
| L2-5 | `/root/.local/bin/{cs-main,hermes,hermes-acp,hermes-agent}`（profile wrapper，可执行） | ≈ 350 | 350 B |
| **L2 小计** | | **356,626** | **≈ 348.3 KiB** |

**实测对照（tar 试打包，2026-11-23）**：`/root/.hermes` 用上述排除集 → `tar` 产物 **85,688,320 B / 3,117 成员**，`./cron/jobs.json`、`./secrets/kb_mail.env`、`./SOUL.md`、`./config.yaml`、`./auth.json`、`./skills/`(1,703)、`./scripts/`(22)、`./memories/`(3) 全部在内，`./profiles`、`./state.db`、`./tools`、`./cache` 全部为 0；`skills/` 单独 gzip 后 **31,458,624 B**（压缩率 44%）。

**不备（可重装/可重下）**：`/opt/web_cs/venv` 5,394,673,102 B（5.02 GiB）、`/usr/local/lib/hermes-agent` 2,032,536,653 B（1.89 GiB）、`/root/.hermes/tools` 2,779,789,963 B（2.59 GiB）、`/root/.hermes/cache` 1,605,874,931 B、`/root/.hermes/profiles` 32,930,746 B（L1-2 已单独覆盖 cs-main）、`state.db` 52,580,352 B、`state-snapshots` 654,526,595 B、`legacy text2vec` 409,223,524 B（390 MiB）、Docker 镜像、**模型权重 818,815,474 B（781 MiB，恢复时联网下载）**。

**包体影响**：基线包 630,323,252 B（≈601 MiB，v0.2.4 真机实测）。L1 六条未压缩合计 ≈236.7 MiB，按 `skills/` 实测压缩率（44%）外推，`tar.zst` 后净增预计 **约 +60~90 MiB**，即最终包体约 **665~695 MiB**。L2 的 348 KiB 可忽略。

---

## 3. L1 — 扩展 `extraPaths`（零改码）

### 3.1 目标配置（GUI：设置 → 服务器 → toogel → 编辑 → 额外路径）

| # | name | path | exclude | maxBytes |
|:-:|:--|:--|:--|--:|
| 1 | `vault` | `/root/Documents/Obsidian Vault` | `./.git` | `null` |
| 2 | `web-cs` | `/opt/web_cs` | `./venv`, `./.git`, `./__pycache__`, `./backups`, `./query_log.db-shm`, `./query_log.db-wal` | `null` |
| 3 | `hermes-profile` | `/root/.hermes/profiles/cs-main` | `./cache`, `./.git`, `./logs`, `./sessions`, `./state.db`, `./state.db-shm`, `./state.db-wal`, `./bin`, `./models_dev_cache.json` | `null` |
| 4 | `web-stack` | `/opt/1panel/www` | `./log`, `./index` | `null` |
| 5 | `sys-units` | `/etc/systemd/system` | （无） | `null` |
| 6 | `hermes-home` | `/root/.hermes` | `./tools`, `./profiles`, `./cache`, `./node`, `./installs`, `./lsp`, `./bin`, `./state-snapshots`, `./logs`, `./sessions`, `./plugins`, `./state.db`, `./state.db-shm`, `./state.db-wal`, `./state.db.fts_rebuild.lock`, `./memory_store.db`, `./memory_store.db-shm`, `./memory_store.db-wal`, `./kanban.db`, `./kanban.db-shm`, `./kanban.db-wal`, `./kanban.db.dispatch.lock`, `./kanban.db.init.lock`, `./projects.db`, `./shared-state.db`, `./shared-state.db-shm`, `./shared-state.db-wal`, `./verification_evidence.db`, `./models_dev_cache.json`, `./models_dev_cache.etag`, `./audio_cache`, `./image_cache`, `./images`, `./tmp`, `./sandboxes`, `./terminal-sessions`, `./pastes`, `./pending`, `./pending_messages`, `./plans`, `./backups`, `./gateway`, `./runtime`, `./source-checks`, `./state`, `./telemetry`, `./vault`, `./.git`, `*.lock`, `./gateway.pid`, `./gateway.sock`, `./gateway-starts.log`, `./interrupt_debug.log`, `./context_length_cache.yaml`, `./context_length_cache.yaml.lock` | `null` |

**关键：`hermes-home` 必须排除 `./profiles`**——否则会把整个 `profiles/` 再打一遍（32.9 MB），与 L1-3 的 `hermes-profile` 重复，且 tar 试打包实测会从 85,688,320 B 涨到 264,550,400 B。

**全部 `maxBytes` 设 `null` 的理由**：`lib/extra-paths.js:150-155` 要求 `maxBytes` 是**正整数**或 `null`；给每条设固定上限会在目录自然增长时**整体拒绝备份**（fail-closed 太脆）。改用「远端空间预检（`extraBytes*1.5 + dumpBytes*2 + 512MiB`）+ 体积在回执里可见」来管控，而不是硬上限。

**为何不做第 7 条 `/root/scripts/kb`**：`MAX_EXTRAS = 8`（`lib/extra-paths.js:14`），6 条留 2 条余量；`/root/scripts/kb` 与 `/etc/cron.d` 归 L2，避免顶到上限后下次加条直接报错。

### 3.2 `exclude` 语义（实测，b3/b39 两次验证）

- `./` 前缀 = **顶层锚定**，`--exclude=./venv` 只排源根下的 `venv/`。
- **排一个目录名即整棵子树消失**，不必写 `./venv/*`（实测：`--exclude=./cache` 后产物只剩 `./`、`./keep/`、`./keep/c.txt`）。
- 裸名（不带 `./`）= 按任意路径分量匹配，容易误伤。
- 多条 exclude 逐条生效、互不干扰。

### 3.3 步骤

1. 打开 `http://127.0.0.1:15082` → 设置 → **Odoo 备份** → **服务器** tab → toogel 卡片 → **编辑**。
2. 在「额外路径」区块逐条填 name / path / exclude（逗号分隔）/ 删除多余行；点「添加额外路径」加行。
3. 保存 → 校验：`GET http://127.0.0.1:15082/odoo-backup/servers` 应回 200；`cordis.patch.yml` 的 `odoo-backup.servers[0].extraPaths` 应有 6 条。
4. 跑一次 `odoo_backup action=backup server=toogel`，看进度里 `packing-extras` 是否 6 次预检 + 6 次打包，以及回执里 6 条 name/bytes/sha256。

### 3.4 验收判据

- `odoo_backup action=listServers` → `toogel → root@47.121.205.143:22（6 条额外路径）`。
- 备份回执 `extras.length === 6`，每条 `bytes > 0` 且 `sha256` 为 64 位小写 hex。
- 下载后解密，包内 6 个 `<name>-<ts>.tar.zst`，`zstd -t` 全过。
- `hermes-home` 包解出的成员里**不含** `tools/`、`cache/`、`state.db`。

### 3.5 风险与对策

| 风险 | 对策 |
|:--|:--|
| `web_cs/query_log.db` 是活跃 WAL，打包可能抓到半写状态 | 已排 `-shm`/`-wal`；主库 1.1 MB 仅作分析用，残缺不影响 recovery |
| `/etc/systemd/system` 含无关 unit（44 项 / 17 个 .service） | 仅 9 KB，可接受；L2 另存真正相关的 2 个 unit 作冗余 |
| `hermes-home` 若漏排 `./profiles` 会重复打包 32.9 MB | 已在 exclude 首部列 `./profiles`；§2 有 tar 试打包成员数对照（3,117 vs 8,248） |
| `*.lock` 裸名匹配会命中 `./state.db.fts_rebuild.lock` 等 | 这是**有意为之**（锁文件全排）；但裸名不锚定顶层，若要严格可逐个写成 `./xxx.lock` |
| 远端空间预检：`extraBytes*1.5 + dumpBytes*2 + 512MiB` ≈ 1.9 GB，可用 22.9 GB | 通过 |
| `exclude` 单条上限 200 字符（`MAX_EXCLUDE_LENGTH`） | 最长那条（`hermes-home` 的 58 条）总长约 900 字符，但**单条**最长仅 `./state.db.fts_rebuild.lock` 25 字符，逐条计算合格 |

---

## 4. L2 — 单文件补齐的独立辅助脚本

**理由**：`extraPaths` 只接受目录；且 `/etc/cron.d` 与 `/root/scripts/kb` 属于运维配套，塞进加密包会把包体语义搅浑。**不改插件**。

### 4.1 新增脚本

`dsh-odoo-backup/scripts/aux-snapshot.sh`（本地 Windows 侧由 pwsh 调用 ssh；或直接在 toogel 上以 cron 运行——二选一，见 §4.3）。

```bash
#!/usr/bin/env bash
# aux-snapshot.sh — 把 extraPaths 覆盖不到的散文件打成小包
set -uo pipefail
TS="$(date +%Y%m%d-%H%M%S)"
OUT="/srv/backups/aux"
mkdir -p "$OUT"
LIST="$OUT/.list.$$"
trap 'rm -f "$LIST"' EXIT

# 单文件清单（每个路径一行，缺失则记入 .missing 并继续）
for f in \
  /etc/cron.d/kb-governance \
  /etc/cron.d/rag-backup \
  /etc/cron.d/vault-sync \
  /root/.hermes/cron/jobs.json \
  /root/.hermes/secrets/kb_mail.env \
  /root/.local/bin/cs-main \
  /root/.local/bin/hermes \
  /root/.local/bin/hermes-acp \
  /root/.local/bin/hermes-agent \
  /etc/systemd/system/webchat.service \
  /etc/systemd/system/socat-odoo-proxy.service
do
  if [ -e "$f" ]; then printf '%s\n' "${f#/}" >> "$LIST"; else printf '%s\n' "$f" >> "$OUT/.missing"; fi
done

tar -C / --numeric-owner --files-from="$LIST" -czf "$OUT/aux-$TS.tar.gz"
sha256sum "$OUT/aux-$TS.tar.gz" > "$OUT/aux-$TS.tar.gz.sha256"
# 目录类（保留完整子树）
tar -C /root --numeric-owner -czf "$OUT/kb-scripts-$TS.tar.gz" scripts/kb
sha256sum "$OUT/kb-scripts-$TS.tar.gz" > "$OUT/kb-scripts-$TS.tar.gz.sha256"

# 保留最近 12 份
ls -1t "$OUT"/aux-*.tar.gz | tail -n +13 | xargs -r rm -f
ls -1t "$OUT"/kb-scripts-*.tar.gz | tail -n +13 | xargs -r rm -f
echo "OK ts=$TS files=$(wc -l < "$LIST")"
```

### 4.2 验收判据

- `ls -l /srv/backups/aux/` 有 `aux-<TS>.tar.gz` + `.sha256`，`sha256sum -c` 通过。
- `tar -tzf aux-<TS>.tar.gz` 成员数 == 清单行数，且必含 `etc/cron.d/rag-backup`、`root/.hermes/cron/jobs.json`、`etc/systemd/system/webchat.service`。
- `.missing` 为空，或每个缺失项都有解释。
- **已知风险**：`/srv/backups` 与 `/` **同盘**（`/dev/vda3`，99G 用 72G）——本机任何备份都不构成异地容灾。故 §4.3 强制把 L2 产物拉回本机。

### 4.3 调度（二选一，默认 A）

- **A（推荐）**：不装 cron，**跟随插件备份一起手动/Agent 触发**——备份完在 DSH 侧用 `scp` 把 `/srv/backups/aux/` 最新两份拉回 `K:\Backup\odoo\aux\`。优点：不新增服务器上的自动化，与「知识库→本机」路径一致。
- **B**：装 `/etc/cron.d/aux-snapshot`（`30 4 * * 0`），但产物仍留在服务器 → 与已有 `rag-backup` 同样的单盘风险，**不解决异地问题**。

> `vault_sync.sh` / `rag_backup.sh` 的既有机制不替代本层：`rag-backup` 只打 `01-客服知识库`，`vault-sync` 只同步 git，都不含 `web_cs`/`cs-main`/unit/cron。

---

## 5. L3 — Dense 索引重建（5 步 SOP，含单独批准）

### 5.1 现状

- 索引 `embeddings/v1/` 三件套 mtime 全 `2026-08-01 19:47:37`，`file_count=37` / `chunk_count=458`。
- 业务缺口 3 篇 / 30 chunks：`00-知识来源/TOOGEL-网站知识来源登记.md`(14)、`06-平台政策/03-官网配送与退换货政策.md`(9)、`02-CO₂与电源知识/02-液态CO₂气瓶选购指南.md`(7)。
- 陈旧 12 篇 / 156 chunks（34.1%）——**这才是重建的主要收益**。
- 无 cron 重建：`grep -rn build_embeddings /root/scripts /etc/cron.d /root/.hermes/scripts /root/.hermes/cron` 全空。

### 5.2 步骤（严格按序，第 3 步单独批准）

1. **留回滚点**（只读，无风险）：
   ```bash
   cp -a /opt/web_cs/embeddings/v1 /opt/web_cs/embeddings/v1.bak.20261123
   ls -l /opt/web_cs/embeddings/
   ```
2. **重建**（写 `embeddings/v1/`，不影响运行中进程）：
   ```bash
   /opt/web_cs/venv/bin/python3 /opt/web_cs/scripts/build_embeddings.py
   cat /opt/web_cs/embeddings/v1/metadata.json
   ```
   **验收读 `metadata.json`：`file_count` 必须 == 40、`chunk_count` 必须 == 496**。
   （`build_embeddings.py:109` 的 `SentenceTransformer(...)` 无 `local_files_only`，若缓存被清会联网下载 781 MiB。）
3. **⛔ 单独申请批准 → 重启**：`systemctl restart webchat`
   - 索引是 `server.py:1536` 模块级单例，**不重启则重建无效**。
   - 这是生产服务重启，必须单独批准，不能与第 2 步合并。
4. **验证进程真的换了索引**：
   ```bash
   systemctl show webchat -p MainPID,ExecMainStartTimestamp
   journalctl -u webchat -n 300 --no-pager | grep DenseRetriever
   ```
   必见 `已加载: 496 chunks, 768维`，**不能是 `加载失败`**；时间戳必须是刚才的重启时刻。
   （日志**不打印 `file_count`**，文件数只能读 `metadata.json`——第 2 步已读。）
5. **端到端语义召回**（不看日志，看真实回答）：
   ```bash
   curl -s -X POST http://127.0.0.1:8766/api/chat \
     -H 'Content-Type: application/json' \
     -d '{"message":"官网下单后多久发货，退换货怎么处理"}'
   curl -s -X POST http://127.0.0.1:8766/api/chat \
     -H 'Content-Type: application/json' \
     -d '{"message":"液态二氧化碳气瓶怎么选，规格有哪些"}'
   ```
   → 再 `journalctl | grep KB_FUSION`，两条都应 `Dense=<非0>`，且 `matched_files` 里分别出现 `06-平台政策/03-官网配送与退换货政策.md`、`02-CO₂与电源知识/02-液态CO₂气瓶选购指南.md`。

### 5.3 回滚

`mv /opt/web_cs/embeddings/v1 /opt/web_cs/embeddings/v1.failed && cp -a .../v1.bak.20261123 .../v1 && systemctl restart webchat`。

### 5.4 长期（本次不做，登记为待办）

- 把 `build_embeddings.py` 纳入 `/etc/cron.d`（如每周日 03:30，紧接 `rag-backup`），并让它在末尾自动 `systemctl try-restart webchat`——但自动重启生产服务需先与用户约定窗口。
- 给 `build_embeddings.py` 加 `--dry-run` 与 argparse（当前 `main()` **零参数**）。
- 给 `search()` 加 `file_count` 日志（当前日志只打 chunks 数）。

---

## 6. 恢复顺序（并入知识库 §八 的 17 步，此处只列增量）

在既有 17 步基础上，新增/改写：

| 步 | 动作 | 来源 |
|:-:|:--|:--|
| 6 | 解 **`web-cs-*.tar.zst`** → `/opt/web_cs`，然后 `python3 -m venv venv` + `pip install -r`（venv 不备） | L1-2 |
| 9 | 解 **`hermes-profile-*.tar.zst`** → `/root/.hermes/profiles/cs-main`（`.env` 在其中 → `DEEPSEEK_API_KEY`） | L1-3 |
| 9b | 解 **`hermes-home-*.tar.zst`** → `/root/.hermes`（注意先备份目标目录，排除项已保证不覆盖 state.db） | L1-6 |
| 11 | 解 **`web-stack-*.tar.zst`** → `/opt/1panel/www`（含 `conf.d/www.toogel.cn.conf` 与 `sites/www.toogel.cn/ssl/`） | L1-4 |
| 11b | 解 **`sys-units-*.tar.zst`** → `/etc/systemd/system`，再 `systemctl daemon-reload` | L1-5 |
| 11c | 解 **`aux-*.tar.gz`** 到 `/`（恢复 `/etc/cron.d/*`、`jobs.json`、`kb_mail.env`、profile wrapper） | L2 |
| 11d | 解 **`kb-scripts-*.tar.gz`** → `/root/`（恢复 `scripts/kb`） | L2 |
| 7 | 恢复模型权重 `huggingface-cli download BAAI/bge-base-zh-v1.5`（781 MiB，**不入包**） | 不变 |

---

## 7. 执行顺序与检查点

| 阶段 | 内容 | 检查点 |
|:--|:--|:--|
| P1 | 配 6 条 `extraPaths` 并落盘 | `cordis.patch.yml` 有 6 条；`listServers` 显示「6 条额外路径」 |
| P2 | 真机全链路备份（约 30 分钟） | 回执 `extras.length===6`；解密后 6 个 extras 包 `zstd -t` 全过 |
| P3 | 写 `aux-snapshot.sh` 并真机跑一次 | `.sha256` 校验通过；成员数 == 清单行数 |
| P4 | 把 L2 产物拉回 `K:\Backup\odoo\aux\` | 本机存在同名文件且 sha256 一致 |
| P5 | L3 步骤 1-2（备份 + 重建） | `metadata.json` = 40 / 496 |
| P6 | **申请批准** → L3 步骤 3-5 | 日志 `496 chunks, 768维`；两条查询 `Dense>0` |
| P7 | 更新知识库三处 + 索引补行 | 乱码 0；`updated: 2026-11-23` |

---

## 8. 自审

**Spec 覆盖**：用户 m02487 的要求「新机可完整运行、不漏插件和配置」→ §2 体积表逐项对应、§6 恢复顺序逐条回填；m02902 的五点意见 → §1 逐条给出实测结论与处理。

**占位符扫描**：无 TBD / 「类似上文」/ 「适当处理」。§4.1 脚本为可直接运行的完整实现。

**类型与接口一致性**：`extraPaths` 条目字段严格为 `{name, path, exclude[], maxBytes}`（`index.js:48-61`）；`exclude` 用 `./` 前缀（实测语义）；`maxBytes` 为字节整数或 `null`（`z.union([z.number(), z.const(null)])`）。脚本用 `set -uo pipefail`，不用 `set -e`（沿用插件脚本纪律，避免管道 SIGPIPE 提前退出）。

**已知未解**：

- `.env` 明文密钥入包仍需用户批准（建议收，但只收 `DEEPSEEK_API_KEY`，`QQ_CLIENT_SECRET` 可单独剥离）。
- `/srv/backups` 与源同盘，异地容灾仍缺——L2 默认方案 A 用 `scp` 拉回本机缓解。
- `MAX_EXTRAS=8` 意味着未来再加 3 条就要动常量（1 行 + 1 测试）。
