/**
 * 灾备边界判定层（纯函数，无 IO）。
 *
 * 回答的问题不是「这个路径有没有备份」，而是「**它该不该备份**」。
 *
 * 用户 2026-11-24 的边界裁决（原话）：
 *   「基础设施负责提前准备，灾备系统负责恢复业务状态。」
 *   「这样就不会因为发现 PostgreSQL、OpenResty、1Panel 或其他容器，就把整个
 *     软件安装目录打进备份包。」
 *
 * 与 `coverage.js` 的关系是**正交**：
 *   - `coverage`（main/extraPaths/l2/none）回答「备份在哪」
 *   - `disposition`（本文件）回答「该不该备份」
 * 两者必须同时输出。`PREINSTALLED_RUNTIME` + `coverage: none` 是**正确状态**，
 * 不是缺口；`RESTORE_REQUIRED` + `coverage: none` 才是真缺口。
 *
 * v0.2.8 的 suggest 之所以会把 `/opt/1panel/apps/openresty/openresty/root`、
 * `.../modules`、`.../conf/nginx.conf` 判成缺口，就是因为只有 coverage 没有
 * disposition —— 「没备份」被直接当成了「该备份」。
 */

import {
  normalizePath,
  isUnder,
  pathKind,
  isDbPhysicalData,
  isInstallTreePath,
} from './paths.js';

/** 四分类。顺序即报告里的展示顺序。 */
export const DISPOSITIONS = Object.freeze([
  'RESTORE_REQUIRED',
  'PREINSTALLED_RUNTIME',
  'REBUILDABLE_DEPENDENCY',
  'EXCLUDED',
]);

export const DISPOSITION_LABELS = Object.freeze({
  RESTORE_REQUIRED: '恢复业务状态',
  PREINSTALLED_RUNTIME: '预置运行环境',
  REBUILDABLE_DEPENDENCY: '可重建依赖',
  EXCLUDED: '已排除',
});

/**
 * 「预先安装」的路径前缀。
 *
 * 注意这里**不含** `/opt/1panel` 整树：`/opt/1panel/www`（nginx 站点与证书）与
 * `/opt/1panel/apps/<app>/<ver>/data`（Odoo 数据库目录、filestore）都在它下面，
 * 那些必须恢复。整树当预置会把业务数据一起判成「不用备份」。
 *
 * 也不含 `/opt/1panel/apps`：应用安装树另有 `isInstallTreePath()` 按
 * `/opt/1panel/apps/<app>/<ver>/<sub>` 精确判，粒度更细。
 */
const PREINSTALL_PREFIXES = Object.freeze([
  ['/opt/1panel/db', '1Panel'],
  ['/opt/1panel/agent', '1Panel'],
  ['/opt/1panel/conf', '1Panel'],
  // `/opt/1panel/tools` 是 1Panel 自带的运维工具集（非业务）
  ['/opt/1panel/tools', '1Panel'],
  // **`/opt/1panel/runtime` 不在此列**：它在真机上是
  // `/opt/1panel/runtime/python/attendance/{.env,run.sh}` —— attendance 的业务级
  // 环境变量与启动脚本，属 RESTORE_REQUIRED。把它归成预置会让「恢复业务状态」
  // 丢掉这两个文件，而且丢得很安静（DN-T2 就是这么暴露出来的）。
  ['/root/.hermes/node', 'Hermes'],
  ['/root/.hermes/installs', 'Hermes'],
  ['/root/.hermes/bin', 'Hermes'],
  ['/root/.hermes/lsp', 'Hermes'],
  ['/root/.hermes/tools', 'Hermes'],
  ['/root/.hermes/cache', 'Hermes'],
]);

/**
 * 落在「预置树」内部但**必须恢复**的业务路径。
 *
 * 必须在 PREINSTALL_PREFIXES 之前判定，否则会被祖先的预置判定吞掉。
 *
 * 注意 WAF 不在这里 —— 它的七个子域各有不同职责（sites/conf 要恢复、
 * rules/default/html 是镜像自带、db 是运行状态、geo 可重下），
 * 按子域精确判定见 `resolveWafDisposition()`。整目录一刀切正是 v0.2.8 的错误。
 */
const RESTORE_CARVEOUTS = Object.freeze([
  // OpenResty 的站点、证书、反向代理配置。实测 112,640 B（排日志后），
  // 含 www/kq 两个站点的 ssl、index（搜索引擎验证文件与 llms.txt）、proxy。
  { path: '/opt/1panel/www', name: 'OpenResty', reason: '站点配置、证书与反向代理配置' },
]);

/** 可重建依赖的目录名（按路径任意一段精确匹配）。 */
const REBUILD_SEGMENTS = new Set(['venv', '.venv', 'node_modules', 'site-packages']);

/**
 * 纯运行产物目录名 —— 优先级高于「可重建依赖」。
 *
 * 必须与 `REBUILD_SEGMENTS` 分开：`node_modules` 同时出现在
 * `paths.js` 的 `NONDATA_BASENAMES` 里（那里判 nondata 是给候选层降噪用的），
 * 但在职责层它属于「可重建」而不是「无意义」——两者的区别是**要不要在
 * 报告里告诉人怎么重建**。RBD-D4 就是靠这条区分抓出来的。
 */
const RUNTIME_JUNK_BASENAMES = new Set([
  'log',
  'logs',
  '__pycache__',
  '.cache',
  'cache',
  'tmp',
  'temp',
  '.pytest_cache',
  '.mypy_cache',
  'sessions',
]);

/** WAF 数据目录下各子域的职责（实测依据见 2026-11-24 规格 §4.1）。 */
const WAF_SUBDIR_DISPOSITION = Object.freeze({
  sites: ['RESTORE_REQUIRED', 'WAF 站点级规则与策略（含每站点的 waf.state/mode 与逐项 check 开关）'],
  conf: ['RESTORE_REQUIRED', 'WAF 全局开关、站点域名映射与三个密钥件'],
  rules: ['PREINSTALLED_RUNTIME', 'WAF 内置规则库（78 个文件 mtime 与安装同秒，自定义列表实测全 0 条目）'],
  default: ['PREINSTALLED_RUNTIME', 'WAF 拦截页模板与默认配置（8 个文件全部与安装同秒）'],
  html: ['PREINSTALLED_RUNTIME', 'WAF CC 挑战页/拦截页静态资源（10 个文件全部与安装同秒）'],
  db: ['EXCLUDED', 'WAF 运行状态库（55 个 sqlite 总 389 行全是程序字典，8 个事件库全 0 行）'],
  geo: ['REBUILDABLE_DEPENDENCY', 'GeoIP 数据（可重新下载，但版本变化会影响规则行为）'],
});

/**
 * WAF 可重建数据：geo 库可由 1Panel 重新下载（实测 27,929,215 B）。
 */
const WAF_DATA_ROOT = '/opt/1panel/apps/openresty/openresty/1pwaf/data';

/**
 * 判定单个路径的灾备归属。
 *
 * @param {object} input
 * @param {string} input.path        候选路径（绝对）
 * @param {string} [input.category]  scan 层已打的分类（'db-physical' | 'install-tree'）
 * @param {string[]} [input.sources] 证据来源，仅用于理由文案
 * @param {object} [input.context]   { containers, instance }
 * @returns {{disposition:string, dispositionReason:string, rebuild:object|null, preinstall:object|null}}
 */
export function classifyDisposition(input = {}) {
  const p = normalizePath(input.path);
  if (!p) {
    return result('EXCLUDED', '路径为空或非法，无法判定', null, null);
  }

  // ---- 1. EXCLUDED：运行状态、日志缓存、物理数据库目录 ----
  //
  // 注意：这里**不用** pathKind() 的 'nondata' 判定。pathKind 把 `node_modules`
  // 也算 nondata（那是给候选层降噪用的），但在职责层 node_modules 属于
  // 「可重建依赖」——区别是**要不要在报告里告诉人怎么重建**（RBD-D4）。
  const segs = p.split('/').filter(Boolean);
  const base = segs[segs.length - 1] ?? '';
  if (RUNTIME_JUNK_BASENAMES.has(base)) {
    return result('EXCLUDED', '日志/缓存/构建产物目录：属运行产物，恢复后由运行期自然重建', null, null);
  }
  // 过宽路径不可能是业务资产
  if (pathKind(p) === 'too-broad') {
    return result('EXCLUDED', '路径过宽：备份它等于备份整台机器，既不现实也不可恢复', null, null);
  }
  if (isDbPhysicalData(p)) {
    return result(
      'EXCLUDED',
      '数据库物理数据目录：正确备份方式是逻辑导出（pg_dump / dump.zip），物理目录与版本/页格式绑死，恢复时不可移植',
      null,
      null,
    );
  }
  if (/\.db-(shm|wal)$/.test(base) || /\.lock$/.test(base)) {
    return result('EXCLUDED', 'SQLite 旁路文件或锁文件：属运行期瞬时状态', null, null);
  }

  // ---- 2. WAF 数据目录：按子域精确判定（不能整目录一刀切）----
  const waf = resolveWafDisposition(p);
  if (waf) return waf;

  // ---- 3. REBUILDABLE_DEPENDENCY：可重装或重下，但必须记录重建方法 ----
  if (segs.some((s) => REBUILD_SEGMENTS.has(s))) {
    const seg = segs.find((s) => REBUILD_SEGMENTS.has(s));
    return result(
      'REBUILDABLE_DEPENDENCY',
      `${seg} 目录：可由依赖清单重建，装完不会自动长出来的是「清单」，不是目录本身`,
      seg === 'node_modules'
        ? {
            how: '在项目根执行 npm ci（有 package-lock.json 时）或 npm install',
            source: 'npm registry（见 package.json / package-lock.json）',
            version: '见 package-lock.json',
            verify: 'npm ls --depth=0 无 unmet peer',
          }
        : {
            how: 'python3 -m venv <dir> && <dir>/bin/pip install -r requirements.txt',
            source: 'PyPI（见 requirements*.txt）',
            version: '见 requirements*.txt 与 pyvenv.cfg 的 Python 版本',
            verify: 'python -c "import <关键包>" 全部成功',
          },
      null,
    );
  }
  if (isUnder(p, `${WAF_DATA_ROOT}/geo`) || p.endsWith('.mmdb')) {
    return result(
      'REBUILDABLE_DEPENDENCY',
      'GeoIP 数据：可由 1Panel 重新下载；版本变化会影响规则行为，故必须记录来源与校验值',
      {
        how: '在 1Panel 面板 WAF 页面重新下载 Geo 数据；或按 waf-geo-<TS>.txt 记录的来源地址下载',
        source: '1Panel WAF 内置 Geo 数据源（见 waf-geo-<TS>.txt 的 RECOVER_HOW）',
        version: '见 waf-geo-<TS>.txt 的三个 mmdb sha256 与 mtime',
        verify: 'sha256sum 与 waf-geo-<TS>.txt 记录值逐文件比对',
      },
      null,
    );
  }

  // ---- 4. RESTORE_REQUIRED 挖孔：落在预置树里但属于业务状态的部分 ----
  for (const carve of RESTORE_CARVEOUTS) {
    if (isUnder(p, carve.path) || isUnder(carve.path, p)) {
      return result('RESTORE_REQUIRED', `${carve.name}：${carve.reason}，装完不会自动生成`, null, null);
    }
  }

  // ---- 4. PREINSTALLED_RUNTIME：预装运行环境，不打包但必须记录版本与来源 ----
  for (const [prefix, name] of PREINSTALL_PREFIXES) {
    if (isUnder(p, prefix)) {
      return result('PREINSTALLED_RUNTIME', `${name} 运行环境：恢复前重新安装，不打包`, null, preinstallFor(name, p, input.context));
    }
  }
  if (isInstallTreePath(p) || input.category === 'install-tree') {
    return result(
      'PREINSTALLED_RUNTIME',
      '容器镜像自带的安装树：由镜像重建，不随备份恢复；仅当你在里面改过配置才需要单独备份',
      null,
      preinstallFor(detectRuntimeName(p), p, input.context),
    );
  }

  // ---- 5. 默认：业务状态 ----
  return result('RESTORE_REQUIRED', '业务配置或数据：装完不会自动生成，必须从灾备恢复', null, null);
}

/** 批量计数（含 0 值 —— `预置 0 条` 与 `预置 12 条` 含义完全不同）。 */
export function countDispositions(items) {
  const counts = {};
  for (const d of DISPOSITIONS) counts[d] = 0;
  for (const it of Array.isArray(items) ? items : []) {
    const d = it?.disposition;
    if (d in counts) counts[d] += 1;
  }
  return counts;
}

/** 报告头的一行。 */
export function buildDispositionLines(items) {
  const c = countDispositions(items);
  const parts = DISPOSITIONS.map((d) => `${DISPOSITION_LABELS[d]} ${c[d]} 条`);
  return `职责分布：${parts.join(' / ')}`;
}

function result(disposition, dispositionReason, rebuild, preinstall) {
  return { disposition, dispositionReason, rebuild, preinstall };
}

/**
 * WAF 数据目录按子域判定。
 *
 * 用户 2026-11-24 的批评原话：「现有 1pwaf/data 应进一步区分规则配置、运行状态、
 * 可重建数据，而不是不加区分地全量恢复。」
 *
 * 七个实测子域分成四类（依据见规格 §4.1）：sites/conf 要恢复；
 * rules/default/html 是镜像自带（mtime 全与安装同秒）；db 是运行状态；
 * geo 可重下。**父目录本身**判 RESTORE_REQUIRED 并在理由里写明应收窄，
 * 因为配置层还没拆细时，整目录仍必须进包。
 */
function resolveWafDisposition(p) {
  if (!isUnder(p, WAF_DATA_ROOT)) return null;

  const rel = normalizePath(p).slice(normalizePath(WAF_DATA_ROOT).length).replace(/^\/+/, '');
  if (!rel) {
    return result(
      'RESTORE_REQUIRED',
      'WAF 数据目录：内部混着镜像自带资源与运行状态，配置应拆细为 sites/ 与 conf/ 两条（v0.2.8 整目录打包是错的）',
      null,
      null,
    );
  }

  const sub = rel.split('/')[0];
  const hit = WAF_SUBDIR_DISPOSITION[sub];
  if (!hit) {
    return result('RESTORE_REQUIRED', `WAF 未知子域 ${sub}：无法判定来源，保守按需恢复处理`, null, null);
  }

  const [disposition, reason] = hit;

  if (disposition === 'REBUILDABLE_DEPENDENCY') {
    return result(disposition, reason, {
      how: '在 1Panel 面板 WAF 页面重新下载 Geo 数据；或按 waf-geo-<TS>.txt 记录的来源地址下载',
      source: '1Panel WAF 内置 Geo 数据源（见 waf-geo-<TS>.txt 的 RECOVER_HOW）',
      version: '见 waf-geo-<TS>.txt 的三个 mmdb sha256 与 mtime',
      verify: 'sha256sum 与 waf-geo-<TS>.txt 记录值逐文件比对',
    }, null);
  }

  if (disposition === 'PREINSTALLED_RUNTIME') {
    return result(disposition, reason, null, {
      name: '1Panel WAF',
      version: '2.0（见 1pwaf/data/conf/waf.json）',
      image: '1panel/openresty:1.31.1.1-2-1-noble',
      source: '容器镜像自带，随 1Panel 安装或镜像升级获得',
    });
  }

  return result(disposition, reason, null, null);
}

/** 从路径猜运行环境名。 */
function detectRuntimeName(p) {
  if (p.includes('/openresty')) return 'OpenResty';
  if (p.includes('/postgresql') || p.includes('/postgres')) return 'PostgreSQL';
  if (p.includes('/odoo')) return 'Odoo';
  if (p.includes('/.hermes')) return 'Hermes';
  if (p.includes('/1panel')) return '1Panel';
  return 'Docker 镜像';
}

/**
 * 预装元信息：版本、镜像、来源。
 *
 * 有 `context.containers` 时从挂载反查容器镜像（这是唯一可信的版本来源：
 * 路径名里的版本号可能与实际镜像不符）。
 */
function preinstallFor(name, p, context) {
  const containers = Array.isArray(context?.containers) ? context.containers : [];
  let image = null;
  for (const c of containers) {
    for (const m of c?.mounts ?? []) {
      const src = normalizePath(m?.source);
      if (!src) continue;
      if (isUnder(p, src) || isUnder(src, p)) {
        image = String(c?.image ?? '') || null;
        break;
      }
    }
    if (image) break;
  }
  const version = image && image.includes(':') ? image.slice(image.indexOf(':') + 1) : '未记录';
  return {
    name,
    version,
    image,
    source: image ? `容器镜像 ${image}` : `${name} 官方安装包`,
  };
}
