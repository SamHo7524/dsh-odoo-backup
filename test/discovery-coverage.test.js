import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyCoverage,
  buildCoverageLines,
  COVERAGE_STATES,
} from '../lib/discovery/coverage.js';

/** 造一条最小 extraPaths 条目。 */
function extra(name, path, exclude = []) {
  return { name, path, exclude };
}

// ---------------- DC-C：classifyCoverage 五态 ----------------

test('DC-C1 落在 addonsPath 之内 = main', () => {
  const r = classifyCoverage({
    path: '/opt/1panel/apps/odoo/odoo19/data/addons/chatbot_ai_hermes',
    context: {
      main: { addonsPath: '/opt/1panel/apps/odoo/odoo19/data/addons' },
      extraPaths: [],
      l2: [],
    },
  });
  assert.equal(r.coverage, 'main');
  assert.match(r.reason, /主备份/);
});

test('DC-C2 落在 dataPath 之内 = main', () => {
  const r = classifyCoverage({
    path: '/opt/1panel/apps/odoo/odoo19/data/data/filestore',
    context: {
      main: { dataPath: '/opt/1panel/apps/odoo/odoo19/data/data' },
      extraPaths: [],
      l2: [],
    },
  });
  assert.equal(r.coverage, 'main');
});

test('DC-C3 落在 extraPaths 之下 = extraPaths，且 reason 带条目名', () => {
  const r = classifyCoverage({
    path: '/opt/web_cs/scripts',
    context: {
      main: {},
      extraPaths: [extra('web-cs', '/opt/web_cs', ['./venv'])],
      l2: [],
    },
  });
  assert.equal(r.coverage, 'extraPaths');
  assert.match(r.reason, /web-cs/);
});

test('DC-C4 被该条目的 exclude 排除 = none（关键：不能算覆盖）', () => {
  const r = classifyCoverage({
    path: '/opt/web_cs/venv',
    context: {
      main: {},
      extraPaths: [extra('web-cs', '/opt/web_cs', ['./venv'])],
      l2: [],
    },
  });
  assert.equal(r.coverage, 'none');
  assert.match(r.reason, /排除/);
});

test('DC-C5 落在 L2 范围 = l2', () => {
  const r = classifyCoverage({
    path: '/root/scripts/toogel',
    context: {
      main: {},
      extraPaths: [],
      l2: [
        { kind: 'prefix', path: '/root/scripts', label: 'ops-scripts 包' },
      ],
    },
  });
  assert.equal(r.coverage, 'l2');
  assert.match(r.reason, /ops-scripts/);
});

test('DC-C6 哪个都不命中 = none', () => {
  const r = classifyCoverage({
    path: '/opt/unknown-svc',
    context: { main: {}, extraPaths: [], l2: [] },
  });
  assert.equal(r.coverage, 'none');
});

test('DC-C7 main 优先于 extraPaths（父子重叠时取更硬的证据）', () => {
  const r = classifyCoverage({
    path: '/data/addons/foo',
    context: {
      main: { addonsPath: '/data/addons' },
      extraPaths: [extra('addons-again', '/data')],
      l2: [],
    },
  });
  assert.equal(r.coverage, 'main');
});

// ---------------- DC-U：unverified 叠加标记 ----------------

test('DC-U1 命中 l2 且含「需重建」资产 = l2 + unverified 标记', () => {
  const r = classifyCoverage({
    path: '/opt/web_cs',
    context: {
      main: {},
      extraPaths: [],
      l2: [{ kind: 'prefix', path: '/opt', label: 'x' }],
      recoveryRisks: { '/opt/web_cs': ['venv 需重装'] },
    },
  });
  assert.equal(r.coverage, 'l2');
  assert.deepEqual(r.recoveryRisk, ['venv 需重装']);
});

test('DC-U2 无风险标记时 recoveryRisk 为空数组（不是 undefined）', () => {
  const r = classifyCoverage({
    path: '/opt/web_cs',
    context: { main: {}, extraPaths: [extra('web-cs', '/opt/web_cs')], l2: [] },
  });
  assert.equal(r.coverage, 'extraPaths');
  assert.deepEqual(r.recoveryRisk, []);
});

// ---------------- DC-B：buildCoverageLines ----------------

test('DC-B1 五态计数全出现（含 0 值态，不能省略）', () => {
  const lines = buildCoverageLines([
    { coverage: 'main' },
    { coverage: 'extraPaths' },
    { coverage: 'none' },
  ]);
  for (const st of COVERAGE_STATES) {
    assert.match(lines.text, new RegExp(st));
  }
  assert.equal(lines.counts.main, 1);
  assert.equal(lines.counts.extraPaths, 1);
  assert.equal(lines.counts.l2, 0);
  assert.equal(lines.counts.none, 1);
});

test('DC-B2 计数之和等于条目数', () => {
  const items = [
    { coverage: 'main' },
    { coverage: 'l2' },
    { coverage: 'l2' },
    { coverage: 'none' },
    { coverage: 'extraPaths' },
  ];
  const { counts, total } = buildCoverageLines(items);
  assert.equal(total, 5);
  const sum = counts.main + counts.extraPaths + counts.l2 + counts.none;
  assert.equal(sum, 5);
});

test('DC-B3 有 unverified 风险时单独计数并写进文本', () => {
  const { counts, text } = buildCoverageLines([
    { coverage: 'extraPaths', recoveryRisk: ['venv 需重装'] },
    { coverage: 'none' },
  ]);
  assert.equal(counts.unverified, 1);
  assert.match(text, /未验证恢复/);
});
