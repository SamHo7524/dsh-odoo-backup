/**
 * 外部依赖发现 —— 路径语义层（纯函数，无 IO）。
 *
 * 这里的每个函数都对应一个**真机踩过的坑**，改之前先读注释：
 *  - isUnder：不能用 startsWith，`/opt/web_cs2` 会被误判为 `/opt/web_cs` 的子树
 *  - matchesExclude：必须复刻 GNU tar 的两种语义（`./` 顶层锚定 vs 裸名按路径分量）
 *  - foldPaths：父路径要吞掉子路径，否则报告里会出现「hermes-home」与「hermes-profile」
 *    两条，读者无法判断到底哪个生效
 */

/** 去掉尾部斜杠、折叠重复斜杠。根路径保持 `/`。非字符串返回空串。 */
export function normalizePath(path) {
  if (typeof path !== 'string') return '';
  const trimmed = path.trim();
  if (!trimmed) return '';
  const collapsed = trimmed.replace(/\/{2,}/g, '/');
  if (collapsed === '/') return '/';
  return collapsed.replace(/\/+$/, '');
}

/**
 * target 是否位于 base 之内（含相等）。
 *
 * 绝对不能用 startsWith：`/opt/web_cs2`、`/opt/web_cs.bak` 都会以
 * `/opt/web_cs` 为前缀，但它们不是子树。必须按段比较。
 */
export function isUnder(target, base) {
  const t = normalizePath(target);
  const b = normalizePath(base);
  if (!t || !b) return false;
  if (t === b) return true;
  if (b === '/') return t.startsWith('/');
  return t.startsWith(`${b}/`);
}

/** target 相对 base 的路径；自身返回 ''；不在其下返回 null。 */
export function relativeTo(target, base) {
  const t = normalizePath(target);
  const b = normalizePath(base);
  if (!isUnder(t, b)) return null;
  if (t === b) return '';
  return b === '/' ? t.slice(1) : t.slice(b.length + 1);
}

/** whether strictAncestor 是 child 的严格祖先（不相等）。 */
export function isAncestorOf(strictAncestor, child) {
  const a = normalizePath(strictAncestor);
  const c = normalizePath(child);
  if (!a || !c) return false;
  if (a === c) return false;
  return isUnder(c, a);
}

/** 把绝对路径转成 tar 成员名形态（去掉前导 `/`）。 */
function toMember(rel) {
  return rel ? `./${rel}` : './';
}

/**
 * 复刻 GNU tar `--exclude` 的匹配语义。
 *
 * 实测（2026-11-23）：
 *  - `--exclude=./.git` → **顶层锚定**，只排顶层 `.git`
 *  - `--exclude=cache`  → 按**任意路径分量**匹配，`. /a/b/cache/x` 也排
 *  - `--exclude=./scripts/__pycache__` → 含斜杠的模式按相对路径锚定
 *  - `--exclude=*.lock` → 裸通配，匹配任意层级
 *
 * relPath 传相对路径（相对 extraPaths 的 path），例如 `.git/config`、`a/b/cache/x`。
 * 也容忍传绝对路径前缀 `./` 的形态。
 */
export function matchesExclude(relPath, exclude) {
  // 允许传单个字符串（调用方少写一层数组），内部统一成数组。
  const list = Array.isArray(exclude) ? exclude : typeof exclude === 'string' ? [exclude] : [];
  if (!list.length) return false;

  const raw = String(relPath ?? '');
  // 统一成 'a/b/c' 形态：去掉前导 './' 与 '/'，去掉尾部 '/'
  const rel = raw.replace(/^\.\//, '').replace(/^\/+/, '').replace(/\/+$/, '');
  if (raw === './' || rel === '') return false;

  const segs = rel.split('/');

  for (const pattern of list) {
    if (typeof pattern !== 'string' || !pattern) continue;
    const p = pattern.trim();
    if (!p) continue;

    const anchoredTop = p.startsWith('./');
    const bare = anchoredTop ? p.slice(2).replace(/\/+$/, '') : p.replace(/\/+$/, '');
    if (!bare) continue;

    if (!bare.includes('/')) {
      // 无斜杠：要么顶层锚定（只匹配 segs[0]），要么按任意分量
      const candidates = anchoredTop ? [segs[0]] : segs;
      if (candidates.some((s) => globMatch(s, bare))) return true;
    } else {
      // 含斜杠：按相对路径前缀锚定
      const patSegs = bare.split('/');
      if (patSegs.length > segs.length) continue;
      let hit = true;
      for (let i = 0; i < patSegs.length; i += 1) {
        if (!globMatch(segs[i], patSegs[i])) {
          hit = false;
          break;
        }
      }
      if (hit) return true;
    }
  }
  return false;
}

/** 单段 glob（只支持 `*` 与 `?`，与 tar 的常见用法一致）。 */
function globMatch(str, pattern) {
  if (pattern === '*') return true;
  if (!pattern.includes('*') && !pattern.includes('?')) return str === pattern;
  const re = new RegExp(
    `^${pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
  );
  return re.test(str);
}

/**
 * 父子路径折叠：被某个祖先覆盖的路径合并进祖先，记录 `absorbed` 数。
 *
 * 目的：报告里出现 `/root/.hermes` 与 `/root/.hermes/profiles/cs-main` 两条时，
 * 读者无法判断哪条真正生效；折叠后只剩祖先，并说明「已包含 N 个子路径」。
 */
export function foldPaths(items) {
  const list = (Array.isArray(items) ? items : [])
    .filter((it) => it && normalizePath(it.path))
    .map((it) => ({ ...it, path: normalizePath(it.path), absorbed: 0 }));

  // 按路径长度升序，保证祖先先入结果
  list.sort((a, b) => a.path.length - b.path.length || a.path.localeCompare(b.path));

  const kept = [];
  for (const item of list) {
    const parent = kept.find((k) => isAncestorOf(k.path, item.path));
    if (parent) {
      parent.absorbed += 1;
      parent.absorbedPaths = [...(parent.absorbedPaths ?? []), item.path];
      continue;
    }
    kept.push(item);
  }
  return kept;
}

const TOO_BROAD = new Set([
  '/',
  '/root',
  '/home',
  '/usr',
  '/var',
  '/etc',
  '/opt',
  '/boot',
  '/tmp',
  '/var/lib',
  '/var/lib/docker',
  '/usr/local',
  '/usr/local/lib',
  // 虚拟文件系统：容器常把它挂进来（/proc、/sys、/dev），打包它们既无意义也会失败
  '/proc',
  '/sys',
  '/dev',
  '/run',
]);

/**
 * 系统发布件：**打包它们没有意义**，恢复时由系统包管理器/镜像负责。
 *
 * 真机来历（2026-11-23 第一次扫描）：`/etc/default`、`/etc/sysconfig`、`/etc/localtime`
 * 三条进了 suggest。它们来自 systemd 的 `EnvironmentFile` 父目录与 openresty 的
 * `/etc/localtime` 挂载——都是「读到了一条路径」，但都不是业务数据。
 *
 * 注意：这里**只收精确的系统区**，不能写成 `/etc` 前缀，否则
 * `/etc/systemd/system`（我们真的备份它）、`/etc/cron.d/*` 会被误伤。
 */
const SYSTEM_EXACT = new Set([
  '/etc/localtime',
  '/etc/timezone',
  '/etc/hostname',
  '/etc/hosts',
  '/etc/resolv.conf',
  '/etc/passwd',
  '/etc/group',
  '/etc/shadow',
  '/etc/gshadow',
  '/etc/locale.conf',
  '/etc/machine-id',
  '/etc/os-release',
  '/etc/nsswitch.conf',
  '/etc/fstab',
  '/etc/mtab',
]);

const SYSTEM_PREFIXES = [
  '/etc/default',
  '/etc/sysconfig',
  '/etc/ld.so.conf.d',
  '/etc/apt',
  '/etc/ssl/certs',
  '/etc/ca-certificates',
  '/etc/environment.d',
  '/etc/systemd/journald.conf.d',
];

/** 目录 basename 命中即视为日志/缓存/构建产物，不是业务数据。 */
const NONDATA_BASENAMES = new Set([
  'log',
  'logs',
  '__pycache__',
  'node_modules',
  'sessions',
  '.cache',
  'cache',
  'tmp',
  'temp',
  '.pytest_cache',
  '.mypy_cache',
]);

/** 1Panel 应用树里「镜像自带」的子目录名。这些目录由镜像重建，不是业务数据。 */
const INSTALL_TREE_SUBDIRS = new Set([
  'conf',
  'modules',
  'root',
  'lib',
  'lib64',
  'bin',
  'sbin',
  'include',
  'share',
  'man',
  'html',
  'htdocs',
  'docker-entrypoint-initdb.d',
]);

/** 数据库物理数据目录的父目录特征。它们的正确备份方式是逻辑导出，不是打 tar。 */
const DB_DIR_HINTS = new Set([
  'postgresql',
  'postgres',
  'mysql',
  'mariadb',
  'mongodb',
  'mongo',
  'redis',
  'clickhouse',
]);

/**
 * 容器镜像自带的 env 键名 —— 它们由 `Dockerfile` 的 `ENV` 写死，与业务配置无关。
 *
 * 真机来历：`attendance (python:3.14.0)` 的 env 键里有 `PATH`、`LANG`、
 * `PYTHON_VERSION`、`PYTHON_SHA256`、`GPG_KEY` 五个官方 python 镜像自带项。
 * 把它们当成「API 资产」列出来，会让「恢复时要重新配哪些变量」这份清单失去意义——
 * 真正需要人重建的是 `SECRET_KEY`、`EXEC_SCRIPT` 这类业务键。
 *
 * 只收精确键名，不用前缀匹配：`PYTHONUNBUFFERED` 该排，但假设有人把业务密钥
 * 命名成 `PATH_TO_LICENSE`，前缀匹配就会误杀。
 */
const IMAGE_ENV_KEYS = new Set([
  'PATH',
  'LANG',
  'LANGUAGE',
  'LC_ALL',
  'LC_CTYPE',
  'TERM',
  'HOME',
  'HOSTNAME',
  'PWD',
  'TZ',
  'PYTHON_VERSION',
  'PYTHON_SHA256',
  'PYTHON_PIP_VERSION',
  'PYTHON_SETUPTOOLS_VERSION',
  'PYTHON_GET_PIP_URL',
  'PYTHON_GET_PIP_SHA256',
  'PYTHONUNBUFFERED',
  'PYTHONIOENCODING',
  'PYTHONDONTWRITEBYTECODE',
  'GPG_KEY',
  'NODE_VERSION',
  'YARN_VERSION',
  'ODOO_VERSION',
  'PG_VERSION',
  'PGDATA',
]);

/** env 键名是否由镜像自带（不是业务配置）。 */
export function isImageEnvKey(key) {
  const k = String(key ?? '').trim();
  if (!k) return false;
  return IMAGE_ENV_KEYS.has(k.toUpperCase());
}

/**
 * 镜像安装树判定：`/opt/1panel/apps/<app>/<ver>/<sub>` 且 `<sub>` 是镜像自带目录。
 *
 * 真机来历：openresty 容器 15 个挂载里 `conf`、`modules`、`root` 全被采成候选。
 * 但**不能直接丢掉**——用户要求「可见比干净更重要」，所以保留候选并打
 * `category: 'install-tree'`，在分类层降级为待确认并说明「由镜像重建」。
 */
export function isInstallTreePath(path) {
  const p = normalizePath(path);
  if (!p) return false;
  const segs = p.split('/').filter(Boolean); // ['opt','1panel','apps','openresty','openresty','modules']
  if (segs.length < 6) return false;
  if (segs[0] !== 'opt' || segs[1] !== '1panel' || segs[2] !== 'apps') return false;
  const sub = segs[5];
  return INSTALL_TREE_SUBDIRS.has(sub);
}

/**
 * 数据库物理数据目录判定。
 *
 * 真机来历：PostgreSQL 的 `/opt/1panel/apps/postgresql/postgresql/data`（≈1 GB）
 * 进了 overflow。但它的内容已由主备份的 `dump.zip`（pg_dump 逻辑导出）覆盖，
 * 再打一份物理目录既冗余、又几乎不可用（版本/页格式绑死）。
 */
export function isDbPhysicalData(path) {
  const p = normalizePath(path);
  if (!p) return false;
  const segs = p.split('/').filter(Boolean);
  if (!segs.length) return false;
  const last = segs[segs.length - 1];
  if (last !== 'data') return false;
  return segs.some((s) => DB_DIR_HINTS.has(s));
}

/**
 * 路径粒度判定。过宽路径**永不建议**——备份 `/root` 等于备份整台机器，
 * 既打不动也恢复不了。
 *
 * 返回：'invalid' | 'too-broad' | 'system' | 'nondata' | 'ok'
 */
export function pathKind(path) {
  const p = normalizePath(path);
  if (!p) return 'invalid';
  if (TOO_BROAD.has(p)) return 'too-broad';
  if (SYSTEM_EXACT.has(p)) return 'system';
  if (SYSTEM_PREFIXES.some((pre) => isUnder(p, pre))) return 'system';

  const segs = p.split('/').filter(Boolean);
  const base = segs[segs.length - 1] ?? '';
  // 只看**目录名**，不看文件名：`query_log.db` 的 basename 不是 `log`，
  // 用 includes 判会把所有日志型业务库误杀。
  if (NONDATA_BASENAMES.has(base)) return 'nondata';

  return 'ok';
}

/**
 * 容器内路径 → 宿主机路径。
 *
 * 真机来历：`discover()` 返回的 `confPath` 是**容器内** `/etc/odoo/odoo.conf`，
 * 而候选路径来自 `docker inspect` 的挂载 **Source**（宿主机路径）。两者指向同一个
 * 文件，但字符串不相等，于是主备份明明包含它、扫描却判 `coverage=none`。
 *
 * 规则：取**最长匹配**的挂载 Destination 做前缀替换；无匹配原样返回。
 */
export function mapContainerPathToHost(containerPath, containers) {
  const p = normalizePath(containerPath);
  if (!p) return p;
  let best = null;
  for (const c of Array.isArray(containers) ? containers : []) {
    for (const m of c?.mounts ?? []) {
      const dest = normalizePath(m?.destination);
      const src = normalizePath(m?.source);
      if (!dest || !src) continue;
      if (!isUnder(p, dest)) continue;
      if (!best || dest.length > best.dest.length) best = { dest, src };
    }
  }
  if (!best) return p;
  const rel = relativeTo(p, best.dest);
  if (rel === null || rel === '') return best.src;
  return `${best.src}/${rel}`;
}
