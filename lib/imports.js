import { execRemote } from './ssh.js';

/**
 * Python 标准库顶层模块名（Python 3.11/3.12 常用集）。
 * 仅用于过滤：漏掉某个名字只会导致多尝试一次 import，通过即无害。
 */
const STDLIB = new Set([
  '__future__', 'abc', 'argparse', 'ast', 'asyncio', 'base64', 'binascii', 'bisect',
  'builtins', 'bz2', 'calendar', 'cmath', 'codecs', 'collections', 'concurrent',
  'configparser', 'contextlib', 'copy', 'csv', 'ctypes', 'dataclasses', 'datetime', 'decimal',
  'difflib', 'dis', 'email', 'enum', 'errno', 'faulthandler', 'fcntl', 'filecmp',
  'fileinput', 'fnmatch', 'fractions', 'ftplib', 'functools', 'gc', 'getopt',
  'getpass', 'gettext', 'glob', 'grp', 'gzip', 'hashlib', 'heapq', 'hmac', 'html',
  'http', 'imaplib', 'importlib', 'inspect', 'io', 'ipaddress', 'itertools', 'json',
  'keyword', 'linecache', 'locale', 'logging', 'lzma', 'mailbox', 'math', 'mimetypes',
  'multiprocessing', 'netrc', 'numbers', 'operator', 'os', 'pathlib', 'pdb', 'pickle',
  'pipes', 'pkgutil', 'platform', 'plistlib', 'poplib', 'posixpath', 'pprint',
  'profile', 'pstats', 'pty', 'pwd', 'py_compile', 'queue', 'quopri', 'random', 're',
  'readline', 'reprlib', 'sched', 'secrets', 'select', 'selectors', 'shelve', 'shlex',
  'shutil', 'signal', 'smtplib', 'socket', 'socketserver', 'sqlite3', 'ssl', 'stat',
  'statistics', 'string', 'stringprep', 'struct', 'subprocess', 'sys', 'sysconfig',
  'tarfile', 'tempfile', 'textwrap', 'threading', 'time', 'timeit', 'token',
  'tokenize', 'traceback', 'tracemalloc', 'types', 'typing', 'unicodedata', 'unittest',
  'urllib', 'uuid', 'venv', 'warnings', 'wave', 'weakref', 'webbrowser', 'xml',
  'xmlrpc', 'zipfile', 'zipimport', 'zlib', 'zoneinfo',
]);

export function isStdlib(name) {
  return STDLIB.has(String(name ?? '').split('.')[0]);
}

export function isOdooInternal(name) {
  const top = String(name ?? '').split('.')[0];
  return top === 'odoo' || top === 'openerp';
}

/**
 * 从 Python 源码中提取第三方顶层模块名。
 * 只处理 import / from ... import 语句；相对导入（from . import x）忽略。
 *
 * `localNames`（v0.3.0）：本模块自己的 .py 基名集合。
 * 真机缺陷（2026-11-24）：`tugou_currency_ecb_sync/tests/test_ecb_rate_logic.py:17`
 * 有 `from ecb_rate_logic import (...)`，之前是
 *     sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "models"))
 * 即手动改 sys.path 后导入**同模块内的兄弟文件**。把它当第三方依赖去
 * `python3 -c "import ecb_rate_logic"` 探测必然失败，导致恢复在阶段 C 被误拦。
 *
 * @param {string} source
 * @param {{localNames?: Set<string>}} [options]
 */
export function extractThirdPartyImports(source, { localNames } = {}) {
  const found = new Set();
  const isLocal = (name) => localNames instanceof Set && localNames.has(name);

  for (const rawLine of String(source ?? '').split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    // import a, b.c as d
    const importMatch = line.match(/^import\s+(.+)$/);
    if (importMatch) {
      for (const part of importMatch[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0].trim();
        const top = name.split('.')[0];
        if (top && !isStdlib(top) && !isOdooInternal(top) && !isLocal(top)) found.add(top);
      }
      continue;
    }

    // from x import y   （跳过 from . / from .. 相对导入）
    const fromMatch = line.match(/^from\s+(\S+)\s+import\s+/);
    if (fromMatch) {
      const mod = fromMatch[1];
      if (mod.startsWith('.')) continue;
      const top = mod.split('.')[0];
      if (top && !isStdlib(top) && !isOdooInternal(top) && !isLocal(top)) found.add(top);
    }
  }

  return [...found].sort();
}

/** Odoo 运行时不加载的目录：单元测试与开发脚手架。 */
const NON_RUNTIME_SEGMENTS = new Set(['tests', 'test']);

/**
 * 解析扫描脚本输出（v0.3.0 起按文件归属上报，不再把所有 import 混成一锅）。
 *
 * 旧协议只有 `===IMPORTS===` + 一堆裸 import 行，无法区分
 * 「哪个模块的哪个文件」引入的，因此不能按模块过滤本地兄弟名。
 *
 * @returns {{ok:boolean, modules:string[], files:{module:string, rel:string, imports:string[]}[], reason?:string}}
 */
export function parseImportScan(stdout) {
  const text = String(stdout ?? '');
  if (!text.includes('===END===')) {
    return { ok: false, modules: [], files: [], reason: '扫描未收到 ===END===（结果不完整）' };
  }

  const modSec = text.match(/===MODULES===\n([\s\S]*?)===IMPORTS===/);
  const modules = modSec
    ? modSec[1].split('\n').map((s) => s.trim()).filter(Boolean).filter((s) => s !== 'ADDONS_MISSING')
    : [];

  const impSec = text.match(/===IMPORTS===\n([\s\S]*?)===END===/);
  const files = [];
  if (impSec) {
    for (const line of impSec[1].split('\n')) {
      const s = line.trim();
      if (!s.startsWith('IMP\t')) continue;
      const parts = s.split('\t');
      if (parts.length < 3) continue;
      const rel = parts[1];
      const imp = parts.slice(2).join('\t');
      const module = rel.split('/')[0];
      let rec = files.find((f) => f.rel === rel);
      if (!rec) {
        rec = { module, rel, imports: [] };
        files.push(rec);
      }
      rec.imports.push(imp);
    }
  }

  return { ok: true, modules, files };
}

/**
 * 每个模块自己的 Python 文件基名（同模块内互相 import 的「本地名」）。
 * @returns {Map<string, Set<string>>}
 */
export function collectLocalModuleNames(files) {
  const out = new Map();
  for (const f of Array.isArray(files) ? files : []) {
    const mod = f?.module;
    const rel = f?.rel;
    if (!mod || !rel) continue;
    if (!out.has(mod)) out.set(mod, new Set());
    const base = String(rel).split('/').pop().replace(/\.py$/, '');
    if (base) out.get(mod).add(base);
  }
  return out;
}

/**
 * 从扫描结果里挑出「Odoo 运行时真正需要的第三方依赖」。
 *
 * 三道过滤（每一道都对应一次真实的假阳性）：
 *  1. 跳过 tests/ 与 test/ 目录 —— Odoo 运行时不加载它们，
 *     而测试文件常手动改 sys.path 导入兄弟文件（真机 ecb_rate_logic 案例）；
 *  2. 跳过本模块自己的 .py 基名（本地兄弟）；
 *  3. 原有的标准库 / odoo 命名空间过滤。
 *
 * @param {{module:string, rel:string, imports:string[]}[]} files
 * @returns {string[]}
 */
export function selectRuntimeImports(files) {
  const list = Array.isArray(files) ? files : [];
  const localByModule = collectLocalModuleNames(list);
  const found = new Set();

  for (const f of list) {
    const rel = String(f?.rel ?? '');
    const segs = rel.split('/');
    // segs[0] 是模块名，其余是模块内路径
    if (segs.slice(1).some((s) => NON_RUNTIME_SEGMENTS.has(s))) continue;
    const local = localByModule.get(f?.module) ?? new Set();
    for (const src of Array.isArray(f?.imports) ? f.imports : []) {
      for (const name of extractThirdPartyImports(src, { localNames: local })) found.add(name);
    }
  }

  return [...found].sort();
}

/**
 * 远程脚本：列出 addons 下的自建模块，并抽取其 Python 源码中的**顶层** import。
 *
 * 关键：只取模块顶层（缩进为 0）的 import 语句。
 * 缩进的 import 位于函数/方法/try 块内，通常是懒加载——
 * 缺失时只在调用该功能时才失败，不影响 Odoo 启动和其他模块。
 * 把它算作必需依赖会产生假阳性（实测：sms_alibaba 故意懒加载阿里云 SDK，
 * 缺失属设计预期）。
 */
function buildScanScript() {
  return `
set -uo pipefail
read -r ADDONS

echo "===MODULES==="
if [ -d "$ADDONS" ]; then
  find "$ADDONS" -maxdepth 2 -name '__manifest__.py' 2>/dev/null | while read -r m; do
    dirname "$m"
  done
else
  echo "ADDONS_MISSING"
fi

echo "===IMPORTS==="
if [ -d "$ADDONS" ]; then
  find "$ADDONS" -maxdepth 3 -name '*.py' 2>/dev/null | while read -r f; do
    rel="\${f#"$ADDONS"/}"
    # 顶层 import：行首无空白，且不是续行
    grep -hE '^(import|from)[[:space:]]' "$f" 2>/dev/null | while IFS= read -r line; do
      # 带上文件归属：调用方要按「哪个模块的哪个文件」判断本地兄弟名，
      # 旧的裸行协议分不清 tests/ 里的 import 与运行时 import（v0.3.0 修）
      printf 'IMP\t%s\t%s\n' "$rel" "$line"
    done
  done
fi

echo "===END==="
`;
}

/**
 * 在 Odoo 容器内逐个尝试 import。
 * 模块名经 base64 传入，避免任何 shell 引号问题。
 */
function buildProbeScript() {
  return `
set -uo pipefail
read -r OC
read -r B64LIST

LIST=$(echo "$B64LIST" | base64 -d)

while IFS= read -r m; do
  [ -z "$m" ] && continue
  if docker exec "$OC" python3 -c "import $m" >/dev/null 2>&1; then
    echo "OK:$m"
  else
    echo "FAIL:$m"
  fi
done <<< "$LIST"

echo "===END==="
`;
}

/**
 * 预检：自建模块的第三方依赖是否都能在 Odoo 容器内导入。
 *
 * 这是恢复前的硬闸门——若某个依赖缺失，站点会在切换后才暴露
 * ImportError（"Some modules are not loaded" 只是 ERROR 日志，不中断启动），
 * 那时只能回滚。必须在临时库阶段就查出来。
 */
export async function checkImports({ server, instance }) {
  if (!instance?.addonsPath) {
    return {
      ok: true,
      missing: [],
      checked: [],
      note: '未提供 addonsPath，跳过导入预检',
      skipped: true,
    };
  }

  const scan = await execRemote(server, buildScanScript(), {
    stdin: `${instance.addonsPath}\n`,
    timeoutMs: 120000,
  });

  if (!scan.stdout.includes('===END===')) {
    return {
      ok: false,
      missing: [],
      checked: [],
      error: `扫描自建模块失败：${(scan.stderr || scan.stdout).slice(-300)}`,
    };
  }

  // 按「模块 + 文件」解析，再挑出运行时真正需要的第三方依赖。
  // 不能把 ===IMPORTS=== 整段丢给 extractThirdPartyImports：
  // tests/ 里的 `from ecb_rate_logic import X`（手动 sys.path 导入兄弟文件）
  // 会被当成第三方依赖，探测必然失败，导致恢复被误拦（2026-11-24 真机）。
  const parsed = parseImportScan(scan.stdout);
  if (!parsed.ok) {
    return {
      ok: false,
      missing: [],
      checked: [],
      error: `扫描自建模块失败：${parsed.reason ?? '结果不完整'}`,
    };
  }
  const modules = selectRuntimeImports(parsed.files);

  if (modules.length === 0) {
    return {
      ok: true,
      missing: [],
      checked: [],
      note: '自建模块无第三方依赖',
    };
  }

  const b64List = Buffer.from(`${modules.join('\n')}\n`, 'utf8').toString('base64');
  const probe = await execRemote(server, buildProbeScript(), {
    stdin: `${instance.odooContainer}\n${b64List}\n`,
    timeoutMs: 180000,
  });

  if (!probe.stdout.includes('===END===')) {
    return {
      ok: false,
      missing: [],
      checked: modules,
      error: `容器内导入探测失败：${(probe.stderr || probe.stdout).slice(-300)}`,
    };
  }

  const results = [];
  for (const line of probe.stdout.split('\n')) {
    const m = line.trim().match(/^(OK|FAIL):(.+)$/);
    if (m) results.push({ status: m[1], name: m[2] });
  }

  const missing = results.filter((r) => r.status === 'FAIL').map((r) => r.name);

  return {
    ok: missing.length === 0,
    missing,
    checked: results.map((r) => r.name),
    ...(missing.length > 0
      ? { error: `自建模块缺少运行时依赖：${missing.join(', ')}（需在 ${instance.pydepsPath || '容器 Python 路径'} 中安装）` }
      : {}),
  };
}
