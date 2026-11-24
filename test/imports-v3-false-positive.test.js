import { test } from 'node:test';
import assert from 'node:assert';
import {
  extractThirdPartyImports,
  isStdlib,
  isOdooInternal,
  parseImportScan,
  collectLocalModuleNames,
  selectRuntimeImports,
} from '../lib/imports.js';

/**
 * 2026-11-24 真机缺陷（V3 误报）回归：
 *
 * tugou_currency_ecb_sync/tests/test_ecb_rate_logic.py:17 有 `from ecb_rate_logic import (...)`，
 * 而这行之前是
 *     sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "models"))
 * 即它是**手动改 sys.path 后导入同模块内的兄弟文件**，只在跑单元测试时成立。
 * 旧扫描器把所有 `*.py`（含 tests/）的顶层 import 都当成运行时依赖，
 * 再用 `python3 -c "import ecb_rate_logic"` 探测，必然 FAIL →
 * 整个恢复在阶段 C 被拦下，而实际上备份数据完好。
 *
 * 生产主机存在完全相同的文件与行号，所以这不是测试机特例。
 */

test('V3-1 extractThirdPartyImports 可排除本模块内的兄弟文件', () => {
  const code = 'from ecb_rate_logic import classify_freshness\nimport requests';
  const local = new Set(['ecb_rate_logic']);
  const r = extractThirdPartyImports(code, { localNames: local });
  assert.deepEqual(r, ['requests'], '同模块内的 ecb_rate_logic 不该算第三方依赖');
});

test('V3-2 extractThirdPartyImports 不带 localNames 时行为不变（向后兼容）', () => {
  const code = 'from ecb_rate_logic import X';
  assert.deepEqual(extractThirdPartyImports(code), ['ecb_rate_logic']);
});

test('V3-3 parseImportScan 按文件归属解析扫描结果', () => {
  const stdout = [
    '===MODULES===',
    'tugou_currency_ecb_sync',
    'chatbot_ai_hermes',
    '===IMPORTS===',
    'IMP\ttugou_currency_ecb_sync/models/ecb_rate_sync.py\timport requests',
    'IMP\ttugou_currency_ecb_sync/tests/test_ecb_rate_logic.py\tfrom ecb_rate_logic import X',
    'IMP\tchatbot_ai_hermes/models/x.py\timport requests',
    '===END===',
  ].join('\n');
  const r = parseImportScan(stdout);
  assert.deepEqual(r.modules.sort(), ['chatbot_ai_hermes', 'tugou_currency_ecb_sync']);
  assert.equal(r.files.length, 3);
  assert.equal(r.files[0].module, 'tugou_currency_ecb_sync');
  assert.equal(r.files[0].rel, 'tugou_currency_ecb_sync/models/ecb_rate_sync.py');
  assert.deepEqual(r.files[0].imports, ['import requests']);
});

test('V3-4 parseImportScan 缺 ===END=== 时返回 ok:false（不能把半个结果当成功）', () => {
  const r = parseImportScan('===MODULES===\nx\n===IMPORTS===\nIMP\tx/a.py\timport y\n');
  assert.equal(r.ok, false);
  assert.match(r.reason, /END/);
});

test('V3-5 collectLocalModuleNames 收集每个模块自己的 .py 基名', () => {
  const files = [
    { module: 'mod_a', rel: 'mod_a/models/ecb_rate_logic.py' },
    { module: 'mod_a', rel: 'mod_a/__init__.py' },
    { module: 'mod_b', rel: 'mod_b/helpers.py' },
  ];
  const m = collectLocalModuleNames(files);
  assert.ok(m.get('mod_a').has('ecb_rate_logic'));
  assert.ok(m.get('mod_a').has('__init__'));
  assert.ok(m.get('mod_b').has('helpers'));
  assert.ok(!m.get('mod_a').has('helpers'), '不同模块的本地名不能串');
});

test('V3-6 selectRuntimeImports 跳过 tests/ 目录（Odoo 运行时不加载）', () => {
  const files = [
    { module: 'm', rel: 'm/models/a.py', imports: ['import requests'] },
    { module: 'm', rel: 'm/tests/test_a.py', imports: ['import only_in_test'] },
    { module: 'm', rel: 'm/test/b.py', imports: ['import also_test'] },
  ];
  const r = selectRuntimeImports(files);
  assert.deepEqual(r, ['requests']);
});

test('V3-7 selectRuntimeImports 汇总并去重、排除本地兄弟与标准库', () => {
  const files = [
    { module: 'm', rel: 'm/models/a.py', imports: ['import requests', 'import os', 'from .x import y'] },
    { module: 'm', rel: 'm/models/helpers.py', imports: ['import json'] },
    { module: 'm', rel: 'm/models/b.py', imports: ['from helpers import z', 'import requests'] },
  ];
  const r = selectRuntimeImports(files);
  assert.deepEqual(r, ['requests'], 'helpers 是本地兄弟、os/json 是标准库，都该被过滤');
});

test('V3-8 selectRuntimeImports 不把 tests 里的本地名泄漏到运行时判定', () => {
  const files = [
    { module: 'm', rel: 'm/models/a.py', imports: ['from ecb_rate_logic import x'] },
    { module: 'm', rel: 'm/models/ecb_rate_logic.py', imports: [] },
  ];
  const r = selectRuntimeImports(files);
  assert.deepEqual(r, [], 'ecb_rate_logic 是 m 模块自己的文件，不是第三方依赖');
});

test('V3-9 本地名按模块隔离：A 模块的兄弟名不能吞掉 B 模块的同名真实依赖', () => {
  // 只有「按模块各自取 localNames」才能通过。若实现图省事复用某一个模块的
  // 集合，B 模块对 helpers 的真实第三方依赖就会被静默吞掉。
  const files = [
    { module: 'mod_a', rel: 'mod_a/models/helpers.py', imports: [] },
    { module: 'mod_a', rel: 'mod_a/models/x.py', imports: ['from helpers import y'] },
    { module: 'mod_b', rel: 'mod_b/models/z.py', imports: ['import helpers'] },
  ];
  const r = selectRuntimeImports(files);
  assert.deepEqual(r, ['helpers'], 'mod_b 的 helpers 是第三方依赖，不能被 mod_a 的本地同名文件吞掉');
});

test('V3-10 parseImportScan 同一文件的多个 import 聚合成一条记录', () => {
  const stdout = [
    '===MODULES===',
    'm',
    '===IMPORTS===',
    'IMP\tm/models/a.py\timport os',
    'IMP\tm/models/a.py\timport requests',
    'IMP\tm/models/b.py\timport json',
    '===END===',
  ].join('\n');
  const r = parseImportScan(stdout);
  assert.equal(r.files.length, 2, '两个文件应为两条记录，不是三条');
  const a = r.files.find((f) => f.rel === 'm/models/a.py');
  assert.deepEqual(a.imports, ['import os', 'import requests']);
});
