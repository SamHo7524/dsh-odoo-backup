import { execRemote as defaultExecRemote } from '../ssh.js';
import { discover } from '../discover.js';
import {
  buildRuntimeScanScript,
  parseRuntimeScan,
  buildSystemdScanScript,
  parseSystemdScan,
  buildOdooModuleScript,
  parseOdooModules,
  buildConfigScanScript,
  parseConfigScan,
} from './collectors.js';
import { buildExistenceProbeScript, parseExistenceProbe } from './probe.js';
import { buildCoverageContext, collectCandidatesDetailed, tierCandidates, buildReport } from './scan.js';
import { buildServices } from './services.js';
import { buildDependencyGraph } from './graph.js';

/**
 * 外部依赖发现 —— 编排层（**唯一有 IO 的地方**）。
 *
 * 只读，不写任何生产路径、不改配置、不启停服务。AC-6 靠这一点成立。
 *
 * 降级策略：任一层失败都不中断整次扫描，而是把失败原因写进 `warnings`，
 * 其余层照常出报告。原因很简单——**一份标着「systemd 扫描失败，其余照旧」的
 * 不完整报告，比一次整体失败有用**；整体失败会让用户误以为系统不可用。
 */

/** 只读这四层。任一层异常都被捕获。 */
async function runCollectors({ server, exec, instance, warnings }) {
  const out = { runtime: null, systemd: null, odooModules: null, config: null };

  try {
    const r = await exec(server, buildRuntimeScanScript(), { timeoutMs: 180000 });
    const parsed = parseRuntimeScan(r.stdout);
    if (parsed.ok) out.runtime = parsed;
    else warnings.push(`L3-runtime：${parsed.reason}`);
  } catch (err) {
    warnings.push(`L3-runtime 调用失败：${err?.message ?? String(err)}`);
  }

  try {
    const r = await exec(server, buildSystemdScanScript(), { timeoutMs: 180000 });
    const parsed = parseSystemdScan(r.stdout);
    if (parsed.ok) out.systemd = parsed;
    else warnings.push(`L4-systemd：${parsed.reason}`);
  } catch (err) {
    warnings.push(`L4-systemd 调用失败：${err?.message ?? String(err)}`);
  }

  try {
    if (instance?.pgContainer && instance?.dbName) {
      const r = await exec(server, buildOdooModuleScript(), {
        stdin: `${instance.pgContainer}\n${instance.pgSuperUser ?? 'postgres'}\n${instance.dbName}\n`,
        timeoutMs: 120000,
      });
      const parsed = parseOdooModules(r.stdout);
      if (parsed.ok) out.odooModules = parsed;
      else warnings.push(`L1-odoo：${parsed.reason}`);
    } else {
      warnings.push('L1-odoo：未发现可用的 pg 容器/库名，跳过模块扫描');
    }
  } catch (err) {
    warnings.push(`L1-odoo 调用失败：${err?.message ?? String(err)}`);
  }

  try {
    const r = await exec(server, buildConfigScanScript(), { timeoutMs: 180000 });
    const parsed = parseConfigScan(r.stdout);
    if (parsed.ok) out.config = parsed;
    else warnings.push(`L2-config：${parsed.reason}`);
  } catch (err) {
    warnings.push(`L2-config 调用失败：${err?.message ?? String(err)}`);
  }

  return out;
}

/**
 * 扫描一台服务器的外部依赖与灾备覆盖。
 *
 * @param {object} o
 * @param {object} o.server   配置里的服务器对象
 * @param {Array}  o.extraPaths 运行中的额外路径（来自 config，不重新推导）
 * @param {number} o.maxExtras  MAX_EXTRAS（只用于算剩余容量，不是发现上限）
 * @param {function} [o.exec]  注入点（测试用）
 * @param {function} [o.discoverInstance] 注入点（测试用）
 */
export async function scanExternalDeps({
  server,
  extraPaths = [],
  maxExtras = 8,
  exec = defaultExecRemote,
  discoverInstance = discover,
} = {}) {
  const warnings = [];
  const startedAt = new Date().toISOString();

  let instance = null;
  try {
    const found = await discoverInstance(server);
    instance = found?.instances?.[0] ?? null;
    if (!instance) warnings.push('未发现 Odoo 实例：主备份覆盖线的判定将为空');
  } catch (err) {
    warnings.push(`复用 Odoo 发现失败：${err?.message ?? String(err)}`);
  }

  const collected = await runCollectors({ server, exec, instance, warnings });

  const containers = collected.runtime?.containers ?? [];

  const collectedCandidates = collectCandidatesDetailed({
    runtime: collected.runtime,
    systemd: collected.systemd,
    config: collected.config,
    odoo: instance,
  });
  const candidates = collectedCandidates.candidates;

  // 存在性探针：一次批量验证所有候选（含已覆盖的，便于报告给出真实体积）
  let probe = { ok: true, entries: [] };
  if (candidates.length) {
    try {
      const r = await exec(server, buildExistenceProbeScript(), {
        stdin: `${candidates.map((c) => c.path).join('\n')}\n`,
        timeoutMs: 300000,
      });
      probe = parseExistenceProbe(r.stdout);
      if (!probe.ok) warnings.push(`存在性探针：${probe.reason}`);
    } catch (err) {
      probe = { ok: false, reason: err?.message ?? String(err) };
      warnings.push(`存在性探针调用失败：${err?.message ?? String(err)}`);
    }
  }

  // containers 必须传进去：confPath 来自 discover() 是**容器内**路径，
  // 要映射回宿主机才能认出手主机侧那份备份过的 odoo.conf。
  const context = buildCoverageContext({ instance, extraPaths, containers });
  const tier = tierCandidates({
    candidates,
    context,
    probe,
    maxExtras,
    configuredCount: Array.isArray(extraPaths) ? extraPaths.length : 0,
    ignored: collectedCandidates.ignored,
  });

  const services = buildServices({
    instance,
    units: collected.systemd?.units ?? [],
    ports: collected.runtime?.ports ?? [],
    containers: collected.runtime?.containers ?? [],
    modules: collected.odooModules?.modules ?? [],
    config: collected.config ?? {},
    extraPaths,
  });
  const graph = buildDependencyGraph({ services });

  const report = buildReport({ server: server?.name ?? server?.host ?? '?', tier, graph });

  const capacity = {
    maxExtras,
    configuredCount: Array.isArray(extraPaths) ? extraPaths.length : 0,
    remaining: tier.capacity?.remaining ?? 0,
  };

  return {
    ok: true,
    readOnly: true,
    server: server?.name ?? server?.host ?? '',
    startedAt,
    finishedAt: new Date().toISOString(),
    instance: instance
      ? {
          odooContainer: instance.odooContainer,
          odooVersion: instance.odooVersion,
          dbName: instance.dbName,
          addonsPath: instance.addonsPath,
          dataPath: instance.dataPath,
          pydepsPath: instance.pydepsPath,
          confPath: instance.confPath,
        }
      : null,
    // 四档清单原样返回，便于 Agent 二次处理；报告文本给人看
    counts: tier.counts,
    coverageCounts: tier.coverageCounts,
    dispositionCounts: tier.dispositionCounts,
    capacity,
    covered: tier.covered,
    suggest: tier.suggest,
    confirm: tier.confirm,
    overflow: tier.overflow,
    // 不需要备份的清单（预置运行环境 / 可重建依赖 / 已排除）。
    // 与四档分开返回：它不是「待办」，但也不能丢——丢了下游无法回答
    // 「这台机器上还有什么东西我没备份，为什么不用备份」。
    inventory: tier.inventory ?? [],
    discoveryWarnings: warnings,
    report,
  };
}
