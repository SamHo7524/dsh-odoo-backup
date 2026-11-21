/**
 * v0.2.2 Task 5 Step 5 — UI 备份完成回执显示「额外路径」条目数与总字节。
 *
 * 契约：
 *  - 备份成功且结果含 extras 时，状态行显示条目数与合计体积；
 *  - 无额外路径时不显示该行（老配置零噪音）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

test('CXP-UI6 备份成功回执渲染额外路径条目数与总字节', () => {
  assert.match(src, /额外路径/, '备份回执应提及额外路径');
  // 必须按条数 + 合计体积呈现，且合计来自 extras 的 bytes 求和
  assert.match(src, /extras/, '回执应读取 result.extras');
  assert.match(src, /length/, '回执应给出条目数');
  assert.match(src, /reduce|bytes/, '回执应汇总体积');
});

test('CXP-UI7 无额外路径时不追加额外路径回执（老配置零噪音）', () => {
  // 回执行必须是条件渲染：extras 为空/缺失时不出字面量。
  assert.match(src, /extras\s*&&|extras\.length|Array\.isArray\([^)]*extras/,
    '额外路径回执必须条件渲染，避免空提示');
});
