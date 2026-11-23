# toogel 外部依赖扫描报告（Phase 1 真机）

- 生成时间：2026-11-23T10:02:56.540Z
- 耗时：8.3s　warnings：0
- 实例：1Panel-odoo-kwnb / 19.0-20260619 / db=tg-odoo
- 四档：建议新增 2　已覆盖 18　待确认 12　超出容量 0
- 覆盖分布：main 3 / extraPaths 7 / l2 8 / none 14
- extraPaths（6 条）：vault, web-cs, hermes-profile, web-stack, sys-units, hermes-home

## 一、已覆盖

| 路径 | 覆盖 | 证据 | 覆盖理由 | 恢复风险 |
|:--|:--|:--|:--|:--|
| `/opt/web_cs` | extraPaths | L4-systemd | 位于额外路径「web-cs」(/opt/web_cs) 之下 | 索引可用但已过期时不会自愈：无 cron 重建（RAID 检查 2026-11-23 确认）；重建后必须重启 webchat 才生效（DenseRetriever 是模块级单例）；venv 未备份：新机需重建虚拟环境并 pip install |
| `/root/scripts` | l2 | L2-scope | 位于 L2 独立备份范围（ops-scripts 包（-C /root scripts，排 scripts/kb）：/root/scripts）——不在加密主包内，恢复时需单独取回 |  |
| `/opt/1panel/www` | extraPaths | L3-runtime | 位于额外路径「web-stack」(/opt/1panel/www) 之下 |  |
| `/etc/cron.d/rag-backup` | l2 | L2-scope | 位于 L2 独立备份范围（aux 包单文件：/etc/cron.d/rag-backup）——不在加密主包内，恢复时需单独取回 |  |
| `/etc/cron.d/vault-sync` | l2 | L2-scope | 位于 L2 独立备份范围（aux 包单文件：/etc/cron.d/vault-sync）——不在加密主包内，恢复时需单独取回 |  |
| `/root/.local/bin/hermes` | l2 | L2-scope | 位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/hermes）——不在加密主包内，恢复时需单独取回 |  |
| `/root/.local/bin/cs-main` | l2 | L2-scope | 位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/cs-main）——不在加密主包内，恢复时需单独取回 |  |
| `/etc/cron.d/kb-governance` | l2 | L2-scope | 位于 L2 独立备份范围（aux 包单文件：/etc/cron.d/kb-governance）——不在加密主包内，恢复时需单独取回 |  |
| `/root/.local/bin/hermes-acp` | l2 | L2-scope | 位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/hermes-acp）——不在加密主包内，恢复时需单独取回 |  |
| `/root/.hermes/cron/jobs.json` | extraPaths | L2-scope | 位于额外路径「hermes-home」(/root/.hermes) 之下，相对路径 cron/jobs.json |  |
| `/root/.local/bin/hermes-agent` | l2 | L2-scope | 位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/hermes-agent）——不在加密主包内，恢复时需单独取回 |  |
| `/root/.hermes/profiles/cs-main` | extraPaths | L4-systemd | 位于额外路径「hermes-profile」(/root/.hermes/profiles/cs-main) 之下 | 会话状态库，恢复后历史会话不保证可用 |
| `/root/.hermes/secrets/kb_mail.env` | extraPaths | L2-scope | 位于额外路径「hermes-home」(/root/.hermes) 之下，相对路径 secrets/kb_mail.env |  |
| `/etc/systemd/system/webchat.service` | extraPaths | L2-scope | 位于额外路径「sys-units」(/etc/systemd/system) 之下，相对路径 webchat.service | unit 恢复后需 systemctl daemon-reload 并 enable |
| `/opt/1panel/apps/odoo/odoo19/data/data` | main | L3-runtime,L1-odoo | 位于主备份固定范围（dataPath=/opt/1panel/apps/odoo/odoo19/data/data） |  |
| `/opt/1panel/apps/odoo/odoo19/data/addons` | main | L3-runtime,L1-odoo | 位于主备份固定范围（addonsPath=/opt/1panel/apps/odoo/odoo19/data/addons） |  |
| `/etc/systemd/system/socat-odoo-proxy.service` | extraPaths | L2-scope | 位于额外路径「sys-units」(/etc/systemd/system) 之下，相对路径 socat-odoo-proxy.service | unit 恢复后需 systemctl daemon-reload 并 enable |
| `/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf` | main | L3-runtime | 位于主备份固定范围（hostConfPath=/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf） |  |

## 二、建议新增

| 路径 | 体积 | 证据 | 覆盖状态 |
|:--|--:|:--|:--|
| `/root/attendance-system` | 122.2 MB | L3-runtime | none |
| `/opt/1panel/apps/openresty/openresty/1pwaf/data` | 28.0 MB | L3-runtime | none |

## 三、待确认

| 路径 | 分类 | 体积 | 为什么不建议直接加入 |
|:--|:--|--:|:--|
| `/opt/1panel/apps/openresty/openresty/root` | install-tree | 14.3 KB | 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份 |
| `/opt/1panel/runtime/python/attendance/.env` | — | 197 B | 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录 |
| `/opt/1panel/apps/postgresql/postgresql/data` | db-physical | 953.3 MB | 数据库物理数据目录：应由逻辑导出（pg_dump / dump.zip）覆盖，不建议按目录打包；若需要物理级备份请单独设计 |
| `/opt/1panel/apps/openresty/openresty/modules` | install-tree | 0 B | 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份 |
| `/opt/1panel/runtime/python/attendance/run.sh` | — | 50 B | 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录 |
| `/opt/1panel/apps/openresty/openresty/conf/ssl` | install-tree | 8.0 KB | 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份 |
| `/opt/1panel/apps/openresty/openresty/conf/default` | install-tree | 780 B | 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份 |
| `/opt/1panel/apps/openresty/openresty/conf/mime.types` | install-tree | 5.2 KB | 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录 |
| `/opt/1panel/apps/openresty/openresty/conf/nginx.conf` | install-tree | 1.9 KB | 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录 |
| `/opt/1panel/apps/openresty/openresty/conf/fastcgi_params` | install-tree | 1.3 KB | 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录 |
| `/opt/1panel/apps/openresty/openresty/conf/modules-enabled` | install-tree | 904 B | 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份 |
| `/opt/1panel/apps/openresty/openresty/conf/fastcgi-php.conf` | install-tree | 428 B | 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录 |

## 四、超出配置容量

（无：容量 8 条，已配 6 条，剩余 2 条恰好装下 2 条建议）

## 五、完整报告正文

```
# 外部依赖与灾备覆盖对账 —— toogel

建议新增：2　已覆盖：18　待确认：12　超出容量：0
覆盖分布：main 3 / extraPaths 7 / l2 8 / none 14
未验证恢复（unverified）：4
容量：MAX_EXTRAS=8，已配置 6 条，剩余 2 条
存在性探针：通过
发现总数：32
已忽略（不计入四档）：系统发布件 10 条、日志/缓存目录 1 条、过宽路径 0 条

## 一、建议新增（可写入 extraPaths）
1. /root/attendance-system
  体积 128106463 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
2. /opt/1panel/apps/openresty/openresty/1pwaf/data
  体积 29323683 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime

## 二、已覆盖
1. /opt/web_cs
  覆盖 extraPaths（位于额外路径「web-cs」(/opt/web_cs) 之下）
  证据 L4-systemd
  恢复风险 索引可用但已过期时不会自愈：无 cron 重建（RAID 检查 2026-11-23 确认）；重建后必须重启 webchat 才生效（DenseRetriever 是模块级单例）；venv 未备份：新机需重建虚拟环境并 pip install
2. /root/scripts
  覆盖 l2（位于 L2 独立备份范围（ops-scripts 包（-C /root scripts，排 scripts/kb）：/root/scripts）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
3. /opt/1panel/www
  覆盖 extraPaths（位于额外路径「web-stack」(/opt/1panel/www) 之下）
  证据 L3-runtime
  已包含 2 个被吞并的子路径
4. /etc/cron.d/rag-backup
  覆盖 l2（位于 L2 独立备份范围（aux 包单文件：/etc/cron.d/rag-backup）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
5. /etc/cron.d/vault-sync
  覆盖 l2（位于 L2 独立备份范围（aux 包单文件：/etc/cron.d/vault-sync）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
6. /root/.local/bin/hermes
  覆盖 l2（位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/hermes）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
7. /root/.local/bin/cs-main
  覆盖 l2（位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/cs-main）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
8. /etc/cron.d/kb-governance
  覆盖 l2（位于 L2 独立备份范围（aux 包单文件：/etc/cron.d/kb-governance）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
9. /root/.local/bin/hermes-acp
  覆盖 l2（位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/hermes-acp）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
10. /root/.hermes/cron/jobs.json
  覆盖 extraPaths（位于额外路径「hermes-home」(/root/.hermes) 之下，相对路径 cron/jobs.json）
  证据 L2-scope（低置信）
11. /root/.local/bin/hermes-agent
  覆盖 l2（位于 L2 独立备份范围（aux 包单文件：/root/.local/bin/hermes-agent）——不在加密主包内，恢复时需单独取回）
  证据 L2-scope（低置信）
12. /root/.hermes/profiles/cs-main
  覆盖 extraPaths（位于额外路径「hermes-profile」(/root/.hermes/profiles/cs-main) 之下）
  证据 L4-systemd
  恢复风险 会话状态库，恢复后历史会话不保证可用
  已包含 1 个被吞并的子路径
13. /root/.hermes/secrets/kb_mail.env
  覆盖 extraPaths（位于额外路径「hermes-home」(/root/.hermes) 之下，相对路径 secrets/kb_mail.env）
  证据 L2-scope（低置信）
14. /etc/systemd/system/webchat.service
  覆盖 extraPaths（位于额外路径「sys-units」(/etc/systemd/system) 之下，相对路径 webchat.service）
  证据 L2-scope（低置信）
  恢复风险 unit 恢复后需 systemctl daemon-reload 并 enable
15. /opt/1panel/apps/odoo/odoo19/data/data
  覆盖 main（位于主备份固定范围（dataPath=/opt/1panel/apps/odoo/odoo19/data/data））
  证据 L3-runtime + L1-odoo
  已包含 1 个被吞并的子路径
16. /opt/1panel/apps/odoo/odoo19/data/addons
  覆盖 main（位于主备份固定范围（addonsPath=/opt/1panel/apps/odoo/odoo19/data/addons））
  证据 L3-runtime + L1-odoo
17. /etc/systemd/system/socat-odoo-proxy.service
  覆盖 extraPaths（位于额外路径「sys-units」(/etc/systemd/system) 之下，相对路径 socat-odoo-proxy.service）
  证据 L2-scope（低置信）
  恢复风险 unit 恢复后需 systemctl daemon-reload 并 enable
18. /opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf
  覆盖 main（位于主备份固定范围（hostConfPath=/opt/1panel/apps/odoo/odoo19/data/conf/odoo.conf））
  证据 L3-runtime

## 三、待确认
1. /opt/1panel/apps/openresty/openresty/root
  体积 14592 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份
2. /opt/1panel/runtime/python/attendance/.env
  体积 197 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  说明 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录
3. /opt/1panel/apps/postgresql/postgresql/data
  体积 999572385 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 db-physical
  说明 数据库物理数据目录：应由逻辑导出（pg_dump / dump.zip）覆盖，不建议按目录打包；若需要物理级备份请单独设计
4. /opt/1panel/apps/openresty/openresty/modules
  体积 0 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份
5. /opt/1panel/runtime/python/attendance/run.sh
  体积 50 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  说明 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录
6. /opt/1panel/apps/openresty/openresty/conf/ssl
  体积 8142 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份
7. /opt/1panel/apps/openresty/openresty/conf/default
  体积 780 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份
8. /opt/1panel/apps/openresty/openresty/conf/mime.types
  体积 5347 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录
9. /opt/1panel/apps/openresty/openresty/conf/nginx.conf
  体积 1955 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录
10. /opt/1panel/apps/openresty/openresty/conf/fastcgi_params
  体积 1291 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录
11. /opt/1panel/apps/openresty/openresty/conf/modules-enabled
  体积 904 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 镜像自带安装树：由容器镜像重建，不随备份恢复；仅当你在里面改过配置才需要备份
12. /opt/1panel/apps/openresty/openresty/conf/fastcgi-php.conf
  体积 428 B
  覆盖 none（未命中主备份、extraPaths、L2 任一覆盖线）
  证据 L3-runtime
  分类 install-tree
  说明 单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录

## 四、超出配置容量（完整保留，未截断）
（无）

## 模块 → 服务 → 六类资产

### 1Panel-odoo-kwnb (Odoo)
关联模块 ai_translation_gateway, analytic, api_doc, attachment_indexation, barcodes, barcodes_gs1_nomenclature, chatbot_ai_hermes, delivery, html_builder, html_editor, http_routing, iap, iap_crm, iap_mail, l10n_cn, l10n_cn_city, logistics_tracking, loyalty, onboarding, toogel_china_map, tugou_blog_seo, tugou_currency_ecb_sync, tugou_payment_airwallex, tugou_payment_country_restrict, tugou_proxy_gateway, tugou_sale_pricelist_patch, tugou_seo_suggest, tugou_support_center　关联强度 **explicit**
- config: /etc/odoo/odoo.conf
- data: /opt/1panel/apps/odoo/odoo19/data/data/.local
- files: /opt/1panel/apps/odoo/odoo19/data/addons；/opt/1panel/apps/odoo/odoo19/data/data
- db: tg-odoo
- api: 未发现
- recovery: tg-odoo → 用 odoo_restore 还原主包：安全备份 → 临时恢复 → 验证 → 停机切换 → 验证（失败自动回滚）；/etc/odoo/odoo.conf → 未知（需人工确认）：1Panel-odoo-kwnb (Odoo) 的 config 类资产未声明恢复方式；/opt/1panel/apps/odoo/odoo19/data/data/.local → 未知（需人工确认）：1Panel-odoo-kwnb (Odoo) 的 data 类资产未声明恢复方式；/opt/1panel/apps/odoo/odoo19/data/addons → 未知（需人工确认）：1Panel-odoo-kwnb (Odoo) 的 files 类资产未声明恢复方式；/opt/1panel/apps/odoo/odoo19/data/data → 未知（需人工确认）：1Panel-odoo-kwnb (Odoo) 的 files 类资产未声明恢复方式；tg-odoo → 未知（需人工确认）：1Panel-odoo-kwnb (Odoo) 的 db 类资产未声明恢复方式

### 1panel-agent
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/1panel-agent.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/1panel-agent.service → 未知（需人工确认）：1panel-agent 的 config 类资产未声明恢复方式

### 1panel-core
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/1panel-core.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/1panel-core.service → 未知（需人工确认）：1panel-core 的 config 类资产未声明恢复方式

### aliyun
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/aliyun.service；/etc/sysconfig/aliyun
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/aliyun.service → 未知（需人工确认）：aliyun 的 config 类资产未声明恢复方式；/etc/sysconfig/aliyun → 未知（需人工确认）：aliyun 的 config 类资产未声明恢复方式

### chrony
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/chrony.service；/etc/default/chrony
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/chrony.service → 未知（需人工确认）：chrony 的 config 类资产未声明恢复方式；/etc/default/chrony → 未知（需人工确认）：chrony 的 config 类资产未声明恢复方式

### containerd
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/containerd.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/containerd.service → 未知（需人工确认）：containerd 的 config 类资产未声明恢复方式

### cron
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/cron.service；/etc/default/cron
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/cron.service → 未知（需人工确认）：cron 的 config 类资产未声明恢复方式；/etc/default/cron → 未知（需人工确认）：cron 的 config 类资产未声明恢复方式

### dbus
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/dbus.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/dbus.service → 未知（需人工确认）：dbus 的 config 类资产未声明恢复方式

### docker
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/docker.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/docker.service → 未知（需人工确认）：docker 的 config 类资产未声明恢复方式

### fail2ban
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/fail2ban.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/fail2ban.service → 未知（需人工确认）：fail2ban 的 config 类资产未声明恢复方式

### fwupd
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/fwupd.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/fwupd.service → 未知（需人工确认）：fwupd 的 config 类资产未声明恢复方式

### getty@tty1
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/getty@tty1.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/getty@tty1.service → 未知（需人工确认）：getty@tty1 的 config 类资产未声明恢复方式

### hbrclient
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/hbrclient.service；/etc/sysconfig/hbrclient
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/hbrclient.service → 未知（需人工确认）：hbrclient 的 config 类资产未声明恢复方式；/etc/sysconfig/hbrclient → 未知（需人工确认）：hbrclient 的 config 类资产未声明恢复方式

### hbrclientupdater
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/hbrclientupdater.service；/etc/sysconfig/hbrclientupdater
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/hbrclientupdater.service → 未知（需人工确认）：hbrclientupdater 的 config 类资产未声明恢复方式；/etc/sysconfig/hbrclientupdater → 未知（需人工确认）：hbrclientupdater 的 config 类资产未声明恢复方式

### mihomo
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/mihomo.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/mihomo.service → 未知（需人工确认）：mihomo 的 config 类资产未声明恢复方式

### ModemManager
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/ModemManager.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/ModemManager.service → 未知（需人工确认）：ModemManager 的 config 类资产未声明恢复方式

### multipathd
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/multipathd.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/multipathd.service → 未知（需人工确认）：multipathd 的 config 类资产未声明恢复方式

### networkd-dispatcher
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/networkd-dispatcher.service；/etc/default/%p
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/networkd-dispatcher.service → 未知（需人工确认）：networkd-dispatcher 的 config 类资产未声明恢复方式；/etc/default/%p → 未知（需人工确认）：networkd-dispatcher 的 config 类资产未声明恢复方式

### polkit
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/polkit.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/polkit.service → 未知（需人工确认）：polkit 的 config 类资产未声明恢复方式

### rsyslog
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/rsyslog.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/rsyslog.service → 未知（需人工确认）：rsyslog 的 config 类资产未声明恢复方式

### serial-getty@ttyS0
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/serial-getty@ttyS0.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/serial-getty@ttyS0.service → 未知（需人工确认）：serial-getty@ttyS0 的 config 类资产未声明恢复方式

### socat-odoo-proxy
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/socat-odoo-proxy.service
- data: 未发现
- files: 未发现
- db: tg-odoo
- api: 未发现
- recovery: /etc/systemd/system/socat-odoo-proxy.service → 未知（需人工确认）：socat-odoo-proxy 的 config 类资产未声明恢复方式；tg-odoo → 未知（需人工确认）：socat-odoo-proxy 的 db 类资产未声明恢复方式

### ssh
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/ssh.service；/etc/default/ssh
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/ssh.service → 未知（需人工确认）：ssh 的 config 类资产未声明恢复方式；/etc/default/ssh → 未知（需人工确认）：ssh 的 config 类资产未声明恢复方式

### systemd-journald
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/systemd-journald.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/systemd-journald.service → 未知（需人工确认）：systemd-journald 的 config 类资产未声明恢复方式

### systemd-logind
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/systemd-logind.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/systemd-logind.service → 未知（需人工确认）：systemd-logind 的 config 类资产未声明恢复方式

### systemd-networkd
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/systemd-networkd.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/systemd-networkd.service → 未知（需人工确认）：systemd-networkd 的 config 类资产未声明恢复方式

### systemd-resolved
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/systemd-resolved.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/systemd-resolved.service → 未知（需人工确认）：systemd-resolved 的 config 类资产未声明恢复方式

### systemd-udevd
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/systemd-udevd.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/systemd-udevd.service → 未知（需人工确认）：systemd-udevd 的 config 类资产未声明恢复方式

### tuned
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/tuned.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/tuned.service → 未知（需人工确认）：tuned 的 config 类资产未声明恢复方式

### udisks2
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/udisks2.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/udisks2.service → 未知（需人工确认）：udisks2 的 config 类资产未声明恢复方式

### unattended-upgrades
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/unattended-upgrades.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/unattended-upgrades.service → 未知（需人工确认）：unattended-upgrades 的 config 类资产未声明恢复方式

### user@0
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/user@0.service
- data: 未发现
- files: 未发现
- db: 未发现
- api: 未发现
- recovery: /etc/systemd/system/user@0.service → 未知（需人工确认）：user@0 的 config 类资产未声明恢复方式

### webchat
关联模块 （未关联，link=unknown）　关联强度 **unknown**
- config: /etc/systemd/system/webchat.service；/root/.hermes/profiles/cs-main/.env；/opt/web_cs/kb_config.json；/opt/1panel/www/conf.d/www.toogel.cn.conf
- data: /opt/web_cs/query_log.db；/opt/web_cs/embeddings/v1
- files: /opt/web_cs
- db: 未发现
- api: QQ_APP_ID（shape=***）；QQ_CLIENT_SECRET（shape=***）；DEEPSEEK_API_KEY（shape=***）；GATEWAY_ALLOW_ALL_USERS（shape=***）
- recovery: /opt/web_cs → 恢复 web-cs 额外路径 → 重建 venv（未备份）→ 重建 FAISS 索引 → 重启 webchat；DEEPSEEK_API_KEY → 恢复后轮换 Key（旧 key 不进包，包内只有 deepseek.env）；/etc/systemd/system/webchat.service → 未知（需人工确认）：webchat 的 config 类资产未声明恢复方式；/root/.hermes/profiles/cs-main/.env → 未知（需人工确认）：webchat 的 config 类资产未声明恢复方式；/opt/web_cs/kb_config.json → 未知（需人工确认）：webchat 的 config 类资产未声明恢复方式；/opt/1panel/www/conf.d/www.toogel.cn.conf → 未知（需人工确认）：webchat 的 config 类资产未声明恢复方式；/opt/web_cs/query_log.db → 可直接恢复，历史日志非必需；/opt/web_cs/embeddings/v1 → 新机需用 build_embeddings.py 重建，且必须联网下载 781 MiB 模型；/opt/web_cs → 未知（需人工确认）：webchat 的 files 类资产未声明恢复方式；api → 未知（需人工确认）：webchat 的 api 类资产未声明恢复方式；api → 未知（需人工确认）：webchat 的 api 类资产未声明恢复方式；api → 未知（需人工确认）：webchat 的 api 类资产未声明恢复方式；api → 未知（需人工确认）：webchat 的 api 类资产未声明恢复方式

```