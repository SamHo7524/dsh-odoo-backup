/**
 * v0.2.3 — Config schema 加载守卫。
 *
 * 背景（真实事故，v0.2.2 发布即挂）：`index.js` 里写了
 * `z.number().nullable().default(null)`，而 `@deepseek-ai/schemastery` 的 `z`
 * **没有 `.nullable()` 方法**。入口模块在 import 阶段就抛
 * `TypeError: z.number(...).nullable is not a function`，整个插件条目激活失败
 * （`plugin_manager` 报 "1 entry did not activate"，设置页直接不可用）。
 *
 * 这个缺陷逃过了 742 个单测，因为**没有任何测试 import index.js**：
 * 测试里解析不到 `@deepseek-ai/schemastery`（插件目录没有 node_modules），
 * 而真实加载发生在 DSH profile 里。所以这里用源码级断言兜住。
 *
 * 可空整数的正确写法：`z.union([z.number(), z.const(null)]).default(null)`。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

test('SCH-1 index.js 不得使用 schemastery 不存在的 .nullable()', () => {
  assert.doesNotMatch(
    src,
    /\.nullable\s*\(/,
    'schemastery 的 z 没有 .nullable()；可空字段用 z.union([z.number(), z.const(null)]).default(null)',
  );
});

test('SCH-2 不得使用其他 schemastery 未提供的链式方法', () => {
  // 这份清单来自实测：对 @deepseek-ai/schemastery 逐个探测，下列方法不存在。
  for (const method of ['nullable', 'optional', 'nullish']) {
    assert.doesNotMatch(src, new RegExp(`\\.${method}\\s*\\(`),
      `schemastery 不提供 .${method}()，会让入口 import 阶段直接 TypeError`);
  }
});

test('SCH-3 extraPaths.maxBytes 用 union+const 表达可空整数', () => {
  assert.match(src, /maxBytes:\s*z\s*\.?\s*union\(\[z\.number\(\),\s*z\.const\(null\)\]\)/,
    'maxBytes 必须用 z.union([z.number(), z.const(null)]).default(null)');
});
