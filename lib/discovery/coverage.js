import { normalizePath, isUnder, relativeTo, matchesExclude } from './paths.js';

/**
 * 覆盖判定层（纯函数，无 IO）。
 *
 * 核心立场（用户 2026-11-23 追加要求）：**「目录出现在备份清单里」不等于
 * 「相关功能可以完整恢复」**。所以覆盖不是一个布尔值，而是五态：
 *
 *   main        已在主备份固定范围（addonsPath / dataPath / pydepsPath / odoo.conf）
 *   extraPaths  已在某条 extraPaths 之内，且未被该条目的 exclude 排除
 *   l2          已在 L2 独立脚本范围内（不在加密主包里，恢复是另一条路径）
 *   none        已发现但完全没备份
 *   unverified  叠加标记：已备份，但含「恢复时需重建/联网下载/轮换密钥」的资产
 *
 * unverified 不参与五态互斥（它是叠加的风险标记，不是替代值），
 * 所以 COVERAGE_STATES 只列四个互斥态，unverified 单独计数。
 */

export const COVERAGE_STATES = ['main', 'extraPaths', 'l2', 'none'];

/** 中文标签，报告输出用。 */
export const COVERAGE_LABELS = {
  main: '主备份已覆盖',
  extraPaths: '额外路径已覆盖',
  l2: 'L2 独立备份已覆盖',
  none: '完全未备份',
};

/**
 * 判定单个路径的覆盖状态。
 *
 * 优先级刻意是 main → extraPaths → l2：父路径重叠时取**更硬的证据**
 * （主备份是每台机器都必然执行的，extraPaths 依赖配置，L2 依赖人工跑脚本）。
 */
export function classifyCoverage({ path, context } = {}) {
  const target = normalizePath(path);
  const ctx = context ?? {};
  const main = ctx.main ?? {};
  const extraPaths = Array.isArray(ctx.extraPaths) ? ctx.extraPaths : [];
  const l2 = Array.isArray(ctx.l2) ? ctx.l2 : [];
  const risks = ctx.recoveryRisks ?? {};

  const recoveryRisk = collectRecoveryRisk(target, risks);

  if (!target) {
    return { coverage: 'none', reason: '路径为空，无法判定', recoveryRisk };
  }

  // ① 主备份固定范围
  //    注意 confPath：`discover()` 给的是**容器内**路径（`/etc/odoo/odoo.conf`），
  //    而候选路径来自 `docker inspect` 的挂载 Source（宿主机路径）。同一个文件两种
  //    写法，只按字符串相等判会把「已备份」误判成「完全未备份」（真机踩过）。
  //    所以 confPath 与 hostConfPath 都按文件相等判。
  const mainScope = [
    ['addonsPath', main.addonsPath, 'dir'],
    ['dataPath', main.dataPath, 'dir'],
    ['pydepsPath', main.pydepsPath, 'dir'],
    ['confPath', main.confPath, 'file'],
    ['hostConfPath', main.hostConfPath, 'file'],
  ];
  for (const [key, scope, kind] of mainScope) {
    const s = normalizePath(scope);
    if (!s) continue;
    const hit = kind === 'file' ? target === s : isUnder(target, s);
    if (hit) {
      return {
        coverage: 'main',
        reason: `位于主备份固定范围（${key}=${s}）`,
        recoveryRisk,
      };
    }
  }

  // ② extraPaths —— 必须检查 exclude，否则把「被排除的子目录」误算成已覆盖
  for (const item of extraPaths) {
    const base = normalizePath(item?.path);
    if (!base || !isUnder(target, base)) continue;
    const rel = relativeTo(target, base) ?? '';
    if (rel && matchesExclude(rel, item?.exclude)) {
      return {
        coverage: 'none',
        // 关键：这是「**主动排除**」，不是「忘了备份」。上层必须区别对待——
        // 把主动排除的子目录当成「建议新增」，等于建议用户去备份 venv、.git、
        // __pycache__ 这些故意排掉的东西。
        excludedByExtraPath: { name: item.name, path: base },
        reason: `虽在额外路径「${item.name}」(${base}) 之下，但命中了它的排除规则（${(item.exclude ?? []).join(', ')}）`,
        recoveryRisk,
      };
    }
    return {
      coverage: 'extraPaths',
      reason: `位于额外路径「${item.name ?? '?'}」(${base}) 之下${rel ? `，相对路径 ${rel}` : ''}`,
      recoveryRisk,
    };
  }

  // ③ L2 独立脚本范围
  for (const item of l2) {
    const base = normalizePath(item?.path);
    if (!base) continue;
    const kind = item?.kind ?? 'prefix';
    const hit = kind === 'file' ? target === base : isUnder(target, base);
    if (hit) {
      return {
        coverage: 'l2',
        reason: `位于 L2 独立备份范围（${item?.label ?? kind}：${base}）——不在加密主包内，恢复时需单独取回`,
        recoveryRisk,
      };
    }
  }

  return {
    coverage: 'none',
    reason: '未命中主备份、extraPaths、L2 任一覆盖线',
    recoveryRisk,
  };
}

/** 收集与目标相关的「恢复风险」标记。 */
function collectRecoveryRisk(target, risks) {
  const out = [];
  for (const [key, val] of Object.entries(risks ?? {})) {
    const k = normalizePath(key);
    if (!k) continue;
    if (isUnder(target, k) || isUnder(k, target)) {
      if (Array.isArray(val)) out.push(...val);
      else if (typeof val === 'string' && val) out.push(val);
    }
  }
  return [...new Set(out)];
}

/**
 * 生成覆盖分布摘要。
 *
 * 为什么五态计数必须含 0 值：只说「都覆盖了」是一句没有信息量的话；
 * `l2 0` 与 `l2 5` 的含义完全不同，零值本身是结论。
 */
export function buildCoverageLines(items) {
  const list = Array.isArray(items) ? items : [];
  const counts = { main: 0, extraPaths: 0, l2: 0, none: 0, unverified: 0 };

  for (const it of list) {
    const st = it?.coverage;
    if (COVERAGE_STATES.includes(st)) counts[st] += 1;
    if (Array.isArray(it?.recoveryRisk) && it.recoveryRisk.length) counts.unverified += 1;
  }

  const text = [
    `覆盖分布：main ${counts.main} / extraPaths ${counts.extraPaths} / l2 ${counts.l2} / none ${counts.none}`,
    `未验证恢复（unverified）：${counts.unverified}`,
  ].join('\n');

  return { counts, total: list.length, text };
}
