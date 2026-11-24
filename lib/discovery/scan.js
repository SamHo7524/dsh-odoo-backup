import {
  normalizePath,
  isUnder,
  isAncestorOf,
  pathKind,
  isInstallTreePath,
  isDbPhysicalData,
  mapContainerPathToHost,
} from './paths.js';
import { classifyCoverage, COVERAGE_STATES } from './coverage.js';
import { classifyDisposition, countDispositions, buildDispositionLines } from './disposition.js';
import { ASSET_CLASSES } from './graph.js';

/**
 * 扫描编排层（纯函数，无 IO）+ 报告组装。
 *
 * 四层证据 → 候选路径 → 存在性验证 → 覆盖判定 → 四档分类 → 报告。
 *
 * 关键立场（用户 2026-11-23）：
 *  - `MAX_EXTRAS` **不是发现能力的上限**，只是当前配置写入能力的限制。
 *    所以报告固定四档，超出容量的全部保留在 `overflow`，绝不静默截断。
 *  - 静态代码扫描只产线索，**永不单独产出 suggest**（AC-10）。
 *  - 不存在 / 不可读 → 只能进 `confirm`，绝不进 `suggest`。
 */

/** L2 独立备份的覆盖线（与 `scripts/aux-snapshot.sh` 的实际打包范围一一对应）。 */
export const L2_SCOPE = [
  { path: '/root/scripts', kind: 'prefix', label: 'ops-scripts 包（-C /root scripts，排 scripts/kb）' },
  { path: '/etc/cron.d/kb-governance', kind: 'file', label: 'aux 包单文件' },
  { path: '/etc/cron.d/rag-backup', kind: 'file', label: 'aux 包单文件' },
  { path: '/etc/cron.d/vault-sync', kind: 'file', label: 'aux 包单文件' },
  { path: '/root/.hermes/cron/jobs.json', kind: 'file', label: 'aux 包单文件' },
  { path: '/root/.hermes/secrets/kb_mail.env', kind: 'file', label: 'aux 包单文件' },
  { path: '/root/.local/bin/cs-main', kind: 'file', label: 'aux 包单文件' },
  { path: '/root/.local/bin/hermes', kind: 'file', label: 'aux 包单文件' },
  { path: '/root/.local/bin/hermes-acp', kind: 'file', label: 'aux 包单文件' },
  { path: '/root/.local/bin/hermes-agent', kind: 'file', label: 'aux 包单文件' },
  { path: '/etc/systemd/system/webchat.service', kind: 'file', label: 'aux 包单文件' },
  { path: '/etc/systemd/system/socat-odoo-proxy.service', kind: 'file', label: 'aux 包单文件' },
];

/**
 * 「恢复时需要重建 / 联网下载 / 轮换密钥」的资产登记表。
 *
 * 用户要求区分「已备份」与「可完整恢复」。这张表就是那层区分：这些路径即使
 * 已被覆盖，也要打 `unverified` 标记。
 */
export const RECOVERY_RISKS = {
  '/opt/web_cs/embeddings': [
    '索引可用但已过期时不会自愈：无 cron 重建（RAID 检查 2026-11-23 确认）',
    '重建后必须重启 webchat 才生效（DenseRetriever 是模块级单例）',
  ],
  '/root/.hermes/secrets/deepseek.env': ['恢复后必须轮换 DeepSeek Key，旧 key 不进包'],
  '/root/.hermes/profiles/cs-main/state.db': ['会话状态库，恢复后历史会话不保证可用'],
  '/etc/systemd/system': ['unit 恢复后需 systemctl daemon-reload 并 enable'],
  '/opt/web_cs/venv': ['venv 未备份：新机需重建虚拟环境并 pip install'],
};

/** 构造 classifyCoverage 需要的上下文。extraPaths 取自运行中配置。 */
export function buildCoverageContext({
  instance,
  extraPaths,
  l2 = L2_SCOPE,
  recoveryRisks = RECOVERY_RISKS,
  containers = [],
} = {}) {
  const confPath = normalizePath(instance?.confPath);
  return {
    main: {
      addonsPath: instance?.addonsPath,
      dataPath: instance?.dataPath,
      pydepsPath: instance?.pydepsPath,
      confPath,
      // `discover()` 的 confPath 是**容器内**路径；候选路径是宿主机路径。
      // 这里把容器路径映射回宿主机，否则同一个文件会被判成「完全未备份」。
      hostConfPath: confPath ? mapContainerPathToHost(confPath, containers) : '',
    },
    extraPaths: (Array.isArray(extraPaths) ? extraPaths : []).map((e) => ({
      name: e?.name,
      path: e?.path,
      exclude: e?.exclude ?? [],
    })),
    l2,
    recoveryRisks,
    containers: Array.isArray(containers) ? containers : [],
  };
}

/** 从 ExecStart 里取第一个绝对路径参数，作为「解释器所在目录」的线索。 */
function firstExistingDirLike(cmd) {
  const m = String(cmd ?? '').match(/(\/[A-Za-z0-9_./-]+)/);
  return m ? m[1] : '';
}

/**
 * 收集候选路径（四层证据）+ 分类忽略统计。
 *
 * 每条候选带 `sources: string[]`，报告据此说明「凭什么认为它重要」。
 * `confidence` 缺省为 'high'；只有 L2-config 给的线索是 'low'。
 *
 * `category` 用于分类层降级（`'install-tree'` / `'db-physical'` / `'file'`），
 * 不是用来丢弃的——用户要求「可见比干净更重要」。
 */
export function collectCandidatesDetailed({ runtime, systemd, config, odoo, l2Scope = L2_SCOPE } = {}) {
  const map = new Map();
  const ignored = { system: 0, nondata: 0, tooBroad: 0, invalid: 0 };
  const ignoredPaths = { system: [], nondata: [], tooBroad: [] };
  const seenIgnored = new Set();

  const add = (rawPath, source, confidence = 'high') => {
    const p = normalizePath(rawPath);
    if (!p) {
      ignored.invalid += 1;
      return;
    }
    const kind = pathKind(p);
    if (kind !== 'ok') {
      const bucket = kind === 'too-broad' ? 'tooBroad' : kind;
      // 同一个路径常被多条证据重复提到（`/etc/default` 会被多个 unit 的
      // EnvironmentFile 父目录命中）。去重后再计数，否则「已忽略 9 条」
      // 与用户看到的 4 个目录对不上。
      const key = `${bucket}:${p}`;
      if (!seenIgnored.has(key) && bucket in ignored) {
        seenIgnored.add(key);
        ignored[bucket] += 1;
        if (ignoredPaths[bucket]) ignoredPaths[bucket].push(p);
      }
      return;
    }
    const cur = map.get(p) ?? { path: p, sources: [], confidence: 'high' };
    if (!cur.sources.includes(source)) cur.sources.push(source);
    if (confidence === 'low') cur.confidence = 'low';
    map.set(p, cur);
  };

  // L3-runtime：容器挂载 Source（最硬证据）
  for (const c of runtime?.containers ?? []) {
    for (const m of c?.mounts ?? []) {
      add(m?.source, 'L3-runtime');
    }
    // WorkingDir 是容器内路径，除非它同时是某个挂载的 Destination，否则不能当宿主路径。
    // 简化处理：不做映射，只用挂载源。这条注释就是为了防止后来者把它「顺手加上」。
  }

  // L4-systemd：WorkingDirectory（数据根）+ EnvironmentFile 本身及其父目录
  //
  // EnvironmentFile 既可能是单文件（`/root/.hermes/profiles/cs-main/.env`），
  // 也可能是系统区里的共享文件（`/etc/default/cron`）。前者要留、后者要被
  // `pathKind` 判成 'system' 忽略。**父目录也要走一遍 pathKind**——否则
  // `/etc/default/cron` 的父目录 `/etc/default` 会绕过单文件判定变成候选。
  for (const u of systemd?.units ?? []) {
    if (u?.workingDirectory) add(u.workingDirectory, 'L4-systemd');
    const envFile = normalizePath(u?.environmentFile ?? '');
    if (envFile) {
      add(envFile, 'L4-systemd');
      const idx = envFile.lastIndexOf('/');
      if (idx > 0) add(envFile.slice(0, idx), 'L4-systemd');
    }
    // ExecStart 只用于判断解释器前缀，不把可执行文件当数据目录
    void firstExistingDirLike(u?.execStart);
  }

  // L1-odoo：Odoo 实例自身路径（通常已被主备份覆盖，列出来是为了证明「已覆盖」）
  for (const k of ['addonsPath', 'dataPath', 'pydepsPath']) {
    if (odoo?.[k]) add(odoo[k], 'L1-odoo');
  }

  // L2-scope：L2 辅助脚本已经打包的范围。
  //
  // 这条线存在的理由：L2 是**人工跑脚本**产出的独立包，不在加密主包里，
  // 也没有任何运行时痕迹（没有容器挂载、没有 systemd unit 指向它）。
  // 如果扫描器不从已知清单注入，`/root/scripts` 这类目录根本不会成为候选，
  // 报告里的 `覆盖分布：l2 0` 就永远是 0——而它其实已经被备份了。
  // 置信度标 low：它是**已知清单**不是活性证据，不能凭它单独产出建议。
  for (const item of l2Scope ?? []) {
    add(item?.path, 'L2-scope', 'low');
  }

  // L2-config：静态代码扫描 → **只产低置信线索**
  for (const it of config?.pathLiterals ?? []) {
    add(it?.value, 'L2-config', 'low');
  }

  // 祖先吞并：/opt/web_cs 吞掉 /opt/web_cs/scripts
  const list = [...map.values()].sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));
  const kept = [];
  for (const item of list) {
    const parent = kept.find((k) => isAncestorOf(k.path, item.path));
    if (parent) {
      parent.absorbed = (parent.absorbed ?? 0) + 1;
      for (const s of item.sources) {
        if (!parent.sources.includes(s)) parent.sources.push(s);
      }
      continue;
    }
    kept.push({ ...item });
  }

  // 打分类标记（**不丢弃**）：安装树 / 数据库物理目录
  for (const it of kept) {
    if (isDbPhysicalData(it.path)) it.category = 'db-physical';
    else if (isInstallTreePath(it.path)) it.category = 'install-tree';
  }

  return { candidates: kept, ignored, ignoredPaths };
}

/** 兼容旧签名：只返回候选数组。 */
export function collectCandidates(input) {
  return collectCandidatesDetailed(input).candidates;
}

/**
 * 四档分类。
 *
 * @param {object} o
 * @param {Array} o.candidates  collectCandidates 的输出
 * @param {object} o.context    buildCoverageContext 的输出
 * @param {object} o.probe      parseExistenceProbe 的输出（ok=false 表示整体失败）
 * @param {number} o.maxExtras  MAX_EXTRAS
 * @param {number} o.configuredCount 当前已配置条数
 */
export function tierCandidates({ candidates, context, probe, maxExtras, configuredCount, ignored } = {}) {
  const list = Array.isArray(candidates) ? candidates : [];
  const cap = Number.isFinite(maxExtras) ? maxExtras : 8;
  const used = Number.isFinite(configuredCount) ? configuredCount : 0;
  const remaining = Math.max(0, cap - used);

  const probeOk = probe?.ok === true;
  const byPath = new Map();
  for (const e of probe?.entries ?? []) {
    byPath.set(normalizePath(e?.path), e);
  }

  const covered = [];
  const suggest = [];
  const confirm = [];
  const overflow = [];
  // 第五档：确认「不需要备份」的候选（预置运行环境 / 可重建依赖 / 已排除）。
  //
  // 用户 2026-11-24 的边界裁决要求把「该不该备份」与「有没有备份」分开。
  // 这类条目既不该进 suggest（不要制造待办），也不该进 confirm（没有需要人决定的事），
  // 更不该静默消失（静默消失后无法判断扫描到底看到了什么）。
  const inventory = [];

  for (const c of list) {
    const cov = classifyCoverage({ path: c.path, context });
    // 分类标记可能来自 collectCandidates，也可能是直接传进来的裸候选
    const category = c.category ?? deriveCategory(c.path);
    const disp = classifyDisposition({ path: c.path, category, context });
    const base = {
      path: c.path,
      sources: c.sources ?? [],
      confidence: c.confidence ?? 'high',
      coverage: cov.coverage,
      coverageReason: cov.reason,
      recoveryRisk: cov.recoveryRisk ?? [],
      absorbed: c.absorbed ?? 0,
      // 必须是 `null` 而不是 `undefined`：DSH 工具返回值要过「lossless JSON」检查，
      // `JSON.stringify` 会把 `undefined` 字段整个丢掉，前后不一致即报
      // `value is not lossless JSON`（v0.2.6 首次真机调用就踩了）。
      category: category ?? null,
      disposition: disp.disposition,
      dispositionReason: disp.dispositionReason,
      rebuild: disp.rebuild ?? null,
      preinstall: disp.preinstall ?? null,
    };

    if (cov.coverage !== 'none') {
      covered.push(base);
      continue;
    }

    // 职责判定不是 RESTORE_REQUIRED → 进清单，不进四档。
    // 这一条就是用户要的「不会因为发现 PostgreSQL、OpenResty、1Panel 或其他容器，
    // 就把整个软件安装目录打进备份包」。
    //
    // 必须排在 excludedByExtraPath 之前：venv / node_modules / __pycache__ 这类目录
    // 既命中了额外路径的排除规则、职责上又是「本来就该排除」。若先判排除规则，
    // 它们会落进 confirm 并附上「若该目录其实需要备份，请修改那条排除规则」——
    // 而那条规则是对的，这句话会让用户去改一条正确的规则（RB-T3 抓出）。
    if (disp.disposition !== 'RESTORE_REQUIRED') {
      inventory.push({
        ...base,
        bytes: byPath.get(c.path)?.bytes ?? -1,
        reasons: [
          disp.dispositionReason,
          ...(cov.excludedByExtraPath
            ? [
                `已在额外路径「${cov.excludedByExtraPath.name}」的排除规则内，` +
                  `与职责判定一致（${disp.disposition}），不是缺口`,
              ]
            : []),
        ],
      });
      continue;
    }

    // 命中 extraPaths 的排除规则 → **主动排除**，不是「忘了备份」。
    // 放进 confirm 而不是 suggest：把 venv/.git/__pycache__ 建议成新增，等于让用户
    // 亲手把下次备份撑爆。但也绝不能让它静默消失——排除规则可能写错。
    // 走到这里说明职责判定是 RESTORE_REQUIRED，即「这条排除规则可能把该备份的
    // 业务数据排掉了」，这才是真正需要人确认的情形。
    if (cov.excludedByExtraPath) {
      confirm.push({
        ...base,
        reasons: [
          ...(base.recoveryRisk ?? []),
          `主动排除：命中了额外路径「${cov.excludedByExtraPath.name}」的排除规则，` +
            `但职责判定为 RESTORE_REQUIRED。若该目录其实需要备份，请修改那条排除规则而不是新增路径`,
        ],
      });
      continue;
    }

    // 未覆盖：先看能不能进建议
    const reasons = [...(base.recoveryRisk ?? [])];

    if (!probeOk) {
      confirm.push({ ...base, reasons: [...reasons, '无法验证：存在性探针整体失败，不能据此建议写入配置'] });
      continue;
    }

    const entry = byPath.get(c.path);
    if (!entry) {
      confirm.push({ ...base, reasons: [...reasons, '无法验证：探针未覆盖该路径'] });
      continue;
    }
    if (!entry.exists) {
      confirm.push({ ...base, reasons: [...reasons, '路径不存在：不得写入配置（会让下次备份整体 fail-closed）'] });
      continue;
    }
    if (!entry.readable) {
      confirm.push({ ...base, reasons: [...reasons, '路径不可读：无法确认备份可用性'] });
      continue;
    }

    // 单文件：`extraPaths` 只支持目录（`validateExtraPath` + 远端 `[ -d "$SRC" ]`），
    // 建议成新增会让下次备份直接 fail-closed。容器把 `.env`、`run.sh` 挂进来时
    // 这类候选一定出现（真机 2026-11-23 的 attendance 容器）。
    // 探针没给目录位（旧格式）时 isDir=null，**不做**这个降级，避免凭缺失信息误杀。
    if (entry.isDir === false) {
      confirm.push({
        ...base,
        bytes: entry.bytes,
        reasons: [
          ...reasons,
          '单文件：额外路径只支持目录（远端 `[ -d "$SRC" ]` 校验），要备份它需用 L2 辅助脚本或改成其父目录',
        ],
      });
      continue;
    }

    // 数据库物理数据目录与镜像安装树不再在这里单独降级：它们已由
    // classifyDisposition 判为 EXCLUDED / PREINSTALLED_RUNTIME，走上面的 inventory 分支。
    // 之前把它们放进 confirm 会让「不该备份的东西」出现在待办里（v0.2.8 的问题）。

    // AC-10：静态扫描线索不得单独产品 suggest
    const onlyConfig = (c.sources ?? []).every((s) => s === 'L2-config');
    if (onlyConfig) {
      confirm.push({
        ...base,
        bytes: entry.bytes,
        reasons: [...reasons, '仅静态扫描提到该路径（低置信）：需人工确认它是否真被运行时使用'],
      });
      continue;
    }

    if (suggest.length < remaining) {
      suggest.push({ ...base, bytes: entry.bytes, reasons });
    } else {
      overflow.push({
        ...base,
        bytes: entry.bytes,
        reasons: [...reasons, `超出配置容量：MAX_EXTRAS=${cap}，已配置 ${used} 条，剩余 ${remaining} 条`],
      });
    }
  }

  const coverageCounts = { main: 0, extraPaths: 0, l2: 0, none: 0 };
  for (const it of [...covered, ...suggest, ...confirm, ...overflow, ...inventory]) {
    if (COVERAGE_STATES.includes(it.coverage)) coverageCounts[it.coverage] += 1;
  }

  const dispositionCounts = countDispositions([...covered, ...suggest, ...confirm, ...overflow, ...inventory]);

  const counts = {
    covered: covered.length,
    suggest: suggest.length,
    confirm: confirm.length,
    overflow: overflow.length,
    inventory: inventory.length,
  };

  return {
    covered,
    suggest,
    confirm,
    overflow,
    inventory,
    counts,
    coverageCounts,
    dispositionCounts,
    total: list.length,
    probeOk,
    capacity: { maxExtras: cap, configuredCount: used, remaining },
    // 采集阶段被忽略的噪声（不参与四档计数，只用于说明扫描覆盖面）
    ignored: ignored ?? { system: 0, nondata: 0, tooBroad: 0, invalid: 0 },
  };
}

/** 从路径本身推导分类标记（供未经 collectCandidates 的裸候选使用）。 */
function deriveCategory(path) {
  const p = normalizePath(path);
  if (!p) return undefined;
  if (isDbPhysicalData(p)) return 'db-physical';
  if (isInstallTreePath(p)) return 'install-tree';
  return undefined;
}

/** 报告里一行的渲染。 */
function renderItem(it, index) {
  const bits = [`${index}. ${it.path}`];
  if (typeof it.bytes === 'number' && it.bytes >= 0) bits.push(`  体积 ${it.bytes} B`);
  bits.push(`  覆盖 ${it.coverage}（${it.coverageReason}）`);
  if (it.disposition) bits.push(`  职责 ${it.disposition}（${it.dispositionReason}）`);
  if ((it.sources ?? []).length) bits.push(`  证据 ${it.sources.join(' + ')}${it.confidence === 'low' ? '（低置信）' : ''}`);
  if (it.category) bits.push(`  分类 ${it.category}`);
  if ((it.reasons ?? []).length) bits.push(`  说明 ${it.reasons.join('；')}`);
  if ((it.recoveryRisk ?? []).length) bits.push(`  恢复风险 ${it.recoveryRisk.join('；')}`);
  if (it.absorbed) bits.push(`  已包含 ${it.absorbed} 个被吞并的子路径`);
  return bits.join('\n');
}

/** 渲染单个服务的六类资产。 */
function renderServiceBlock(s) {
  const lines = [`### ${s.service}${s.image ? `（${s.image}）` : ''}`];
  if (s.standalone) {
    lines.push(`关联模块 （无 Odoo 模块引用，link=unknown）　**独立业务系统**`);
  } else {
    lines.push(`关联模块 ${(s.modules ?? []).join(', ') || '（未关联，link=unknown）'}　关联强度 **${s.link}**`);
  }
  for (const cls of ASSET_CLASSES) {
    const items = s.assets?.[cls] ?? [];
    if (!items.length) {
      lines.push(`- ${cls}: 未发现`);
      continue;
    }
    const desc = items
      .map((a) => {
        const name = a.path ?? a.name ?? a.key ?? a.target ?? '?';
        const extra = a.action ? ` → ${a.action}` : '';
        const shape = a.shape ? `（shape=${a.shape}）` : '';
        return `${name}${shape}${extra}`;
      })
      .join('；');
    lines.push(`- ${cls}: ${desc}`);
  }
  // api 类只出现键名与形状，值永不输出（AC-7）
  lines.push('');
  return lines;
}

/** 依赖图渲染：六类资产逐类输出，缺类写「未发现」。 */
function renderGraph(graph) {
  const lines = ['', '## 模块 → 服务 → 六类资产', ''];
  const services = Array.isArray(graph?.services) ? graph.services : [];
  if (!services.length) {
    lines.push('（未建立依赖图：本次扫描未识别到可关联的外部服务）');
    return lines.join('\n');
  }

  // 分两组渲染：用户 2026-11-23 明确要求「独立运行的业务系统」不能被 Odoo 模块依赖
  // 淹没——它们没有模块引用，恰恰是最容易被漏掉的那一类（m05214 第⑤条）。
  const dependent = services.filter((s) => !s.standalone);
  const standalone = services.filter((s) => s.standalone);

  for (const s of dependent) lines.push(...renderServiceBlock(s));

  if (standalone.length) {
    lines.push('');
    lines.push('## 独立业务系统（无 Odoo 模块引用，但运行在同一台业务服务器上）');
    lines.push('');
    lines.push('> 这些系统不依赖任何 Odoo 模块，因此**不会被模块扫描发现**。列在这里是为了回答');
    lines.push('> 一个模块扫描答不出的问题：这台机器上还有哪些业务系统没有纳入灾备。');
    lines.push('');
    for (const s of standalone) lines.push(...renderServiceBlock(s));
  }

  return lines.join('\n');
}

/** 组装最终报告文本。 */
export function buildReport({ server, tier, graph } = {}) {
  const t = tier ?? { counts: {}, coverageCounts: {}, covered: [], suggest: [], confirm: [], overflow: [], inventory: [], capacity: {} };
  const c = t.counts ?? {};
  const cc = t.coverageCounts ?? {};
  const cap = t.capacity ?? {};
  const ig = t.ignored ?? {};
  const inv = t.inventory ?? [];
  const allItems = [...(t.covered ?? []), ...(t.suggest ?? []), ...(t.confirm ?? []), ...(t.overflow ?? []), ...inv];

  const head = [
    `# 外部依赖与灾备覆盖对账 —— ${server ?? '(未知服务器)'}`,
    '',
    `建议新增：${c.suggest ?? 0}　已覆盖：${c.covered ?? 0}　待确认：${c.confirm ?? 0}　超出容量：${c.overflow ?? 0}`,
    `覆盖分布：main ${cc.main ?? 0} / extraPaths ${cc.extraPaths ?? 0} / l2 ${cc.l2 ?? 0} / none ${cc.none ?? 0}`,
    // 职责分布与覆盖分布**必须同时出现**：前者答「该不该备份」，后者答「备份在哪」。
    // 只给后者，「预置运行环境没备份」会被读成缺口（v0.2.8 的问题）。
    buildDispositionLines(allItems),
    `不需要备份（清单另列）：预置运行环境 + 可重建依赖 + 已排除，共 ${inv.length} 条`,
    `未验证恢复（unverified）：${allItems.filter((i) => (i.recoveryRisk ?? []).length).length}`,
    `容量：MAX_EXTRAS=${cap.maxExtras ?? '?'}，已配置 ${cap.configuredCount ?? 0} 条，剩余 ${cap.remaining ?? 0} 条`,
    `存在性探针：${t.probeOk ? '通过' : '失败（未覆盖项全部降级为待确认）'}`,
    `发现总数：${t.total ?? 0}`,
    // 交代「扫描忽略了什么」：不写出来，用户会以为扫描漏了东西。
    `已忽略（不计入四档）：系统发布件 ${ig.system ?? 0} 条、日志/缓存目录 ${ig.nondata ?? 0} 条、过宽路径 ${ig.tooBroad ?? 0} 条`,
  ].join('\n');

  const secs = [
    head,
    '',
    '## 一、建议新增（可写入 extraPaths）',
    (t.suggest ?? []).length ? t.suggest.map((i, n) => renderItem(i, n + 1)).join('\n') : '（无）',
    '',
    '## 二、已覆盖',
    (t.covered ?? []).length ? t.covered.map((i, n) => renderItem(i, n + 1)).join('\n') : '（无）',
    '',
    '## 三、待确认',
    (t.confirm ?? []).length ? t.confirm.map((i, n) => renderItem(i, n + 1)).join('\n') : '（无）',
    '',
    '## 四、超出配置容量（完整保留，未截断）',
    (t.overflow ?? []).length ? t.overflow.map((i, n) => renderItem(i, n + 1)).join('\n') : '（无）',
    renderInventory(inv),
    renderGraph(graph),
  ];

  return secs.join('\n');
}

/**
 * 第五节：不需要备份的清单。
 *
 * 分三组渲染（预置运行环境 / 可重建依赖 / 已排除），因为**用户对这三组要做的动作
 * 完全不同**：预置的要「照单装好」，可重建的要「照单重建」，已排除的只需要知道
 * 「扫描看到过它，但决定不备份」。混在一起会让人不知道从哪下手。
 */
function renderInventory(items) {
  const list = Array.isArray(items) ? items : [];
  const lines = [
    '',
    '## 五、不需要备份的清单（回答「装完变不出来的才要备份」）',
    '',
    '> 基础设施负责提前准备，灾备系统负责恢复业务状态。本节列出的东西**不进灾备包**，',
    '> 但恢复前必须照此准备或重建。它们的 `coverage` 显示 `none` 是**正确状态**，不是缺口。',
  ];

  const groups = [
    ['PREINSTALLED_RUNTIME', '预置运行环境（恢复前装好，不要打包）'],
    ['REBUILDABLE_DEPENDENCY', '可重建依赖（不打包，但必须照此重建）'],
    ['EXCLUDED', '已排除（与业务状态无关）'],
  ];

  for (const [disp, title] of groups) {
    const sub = list.filter((i) => i.disposition === disp);
    lines.push('', `### ${title}　共 ${sub.length} 条`, '');
    if (!sub.length) {
      lines.push('（无）');
      continue;
    }
    for (const it of sub) {
      const bits = [`- ${it.path}`];
      if (typeof it.bytes === 'number' && it.bytes >= 0) bits.push(`  体积 ${it.bytes} B`);
      bits.push(`  原因 ${it.dispositionReason}`);
      if (it.preinstall) {
        const p = it.preinstall;
        bits.push(`  预装 ${p.name}｜版本 ${p.version}｜镜像 ${p.image ?? '—'}｜来源 ${p.source}`);
      }
      if (it.rebuild) {
        const r = it.rebuild;
        bits.push(`  重建 ${r.how}｜来源 ${r.source}｜版本 ${r.version}｜校验 ${r.verify}`);
      }
      lines.push(bits.join('\n'));
    }
  }

  lines.push('');
  return lines.join('\n');
}
