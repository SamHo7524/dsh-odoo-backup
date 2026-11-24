import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  classifyDisposition,
  countDispositions,
  buildDispositionLines,
  DISPOSITIONS,
} from '../lib/discovery/disposition.js';

/** 造一个带挂载的容器。 */
function container(name, image, mounts) {
  return { name, image, mounts: mounts.map(([source, destination]) => ({ source, destination })) };
}

// ---------------- RBD-D：四分类基本判定 ----------------

test('RBD-D1 业务目录默认判 RESTORE_REQUIRED', () => {
  const r = classifyDisposition({ path: '/root/attendance-system' });
  assert.equal(r.disposition, 'RESTORE_REQUIRED');
  assert.match(r.dispositionReason, /装完不会自动生成/);
  assert.equal(r.rebuild, null);
  assert.equal(r.preinstall, null);
});

test('RBD-D2 运行日志判 EXCLUDED', () => {
  const r = classifyDisposition({ path: '/opt/1panel/www/sites/www.toogel.cn/log' });
  assert.equal(r.disposition, 'EXCLUDED');
  assert.match(r.dispositionReason, /运行/);
});

test('RBD-D3 venv 判 REBUILDABLE_DEPENDENCY 且带四项重建信息', () => {
  const r = classifyDisposition({ path: '/root/attendance-system/venv' });
  assert.equal(r.disposition, 'REBUILDABLE_DEPENDENCY');
  assert.ok(r.rebuild, 'rebuild 不能为空');
  for (const k of ['how', 'source', 'version', 'verify']) {
    assert.ok(typeof r.rebuild[k] === 'string' && r.rebuild[k].length > 0, `rebuild.${k} 不能为空`);
  }
  assert.match(r.rebuild.how, /venv/);
});

test('RBD-D4 node_modules 判 REBUILDABLE_DEPENDENCY', () => {
  const r = classifyDisposition({ path: '/opt/app/node_modules' });
  assert.equal(r.disposition, 'REBUILDABLE_DEPENDENCY');
  assert.match(r.rebuild.how, /npm/);
});

test('RBD-D5 数据库物理目录判 EXCLUDED（不是 RESTORE_REQUIRED）', () => {
  const r = classifyDisposition({ path: '/opt/1panel/apps/postgresql/postgresql/data' });
  assert.equal(r.disposition, 'EXCLUDED');
  assert.match(r.dispositionReason, /逻辑导出|pg_dump/);
});

test('RBD-D6 1Panel 平台本体判 PREINSTALLED_RUNTIME', () => {
  const r = classifyDisposition({ path: '/opt/1panel/db' });
  assert.equal(r.disposition, 'PREINSTALLED_RUNTIME');
  assert.equal(r.preinstall.name, '1Panel');
});

test('RBD-D7 Hermes 运行时目录判 PREINSTALLED_RUNTIME', () => {
  const r = classifyDisposition({ path: '/root/.hermes/node' });
  assert.equal(r.disposition, 'PREINSTALLED_RUNTIME');
  assert.equal(r.preinstall.name, 'Hermes');
});

test('RBD-D8 容器镜像安装树判 PREINSTALLED_RUNTIME 并带镜像版本', () => {
  const ctx = {
    containers: [
      container('1Panel-openresty-OI6y', '1panel/openresty:1.31.1.1-2-1-noble', [
        ['/opt/1panel/apps/openresty/openresty', '/usr/local/openresty'],
      ]),
    ],
  };
  const r = classifyDisposition({ path: '/opt/1panel/apps/openresty/openresty/modules', context: ctx });
  assert.equal(r.disposition, 'PREINSTALLED_RUNTIME');
  assert.equal(r.preinstall.image, '1panel/openresty:1.31.1.1-2-1-noble');
  assert.equal(r.preinstall.version, '1.31.1.1-2-1-noble');
  assert.match(r.preinstall.source, /镜像/);
});

test('RBD-D9 空路径判 EXCLUDED', () => {
  const r = classifyDisposition({ path: '' });
  assert.equal(r.disposition, 'EXCLUDED');
  assert.match(r.dispositionReason, /非法|为空/);
});

// ---------------- RBD-W：1pwaf/data 七子域（RB-5） ----------------

const WAF = '/opt/1panel/apps/openresty/openresty/1pwaf/data';

test('RBD-W1 waf sites 判 RESTORE_REQUIRED', () => {
  const r = classifyDisposition({ path: `${WAF}/sites` });
  assert.equal(r.disposition, 'RESTORE_REQUIRED');
  assert.match(r.dispositionReason, /WAF sites|站点/);
});

test('RBD-W2 waf conf 判 RESTORE_REQUIRED', () => {
  const r = classifyDisposition({ path: `${WAF}/conf` });
  assert.equal(r.disposition, 'RESTORE_REQUIRED');
  assert.match(r.dispositionReason, /WAF/);
});

test('RBD-W3 waf rules 判 PREINSTALLED_RUNTIME（镜像自带 78 个文件，mtime 与安装同秒）', () => {
  const r = classifyDisposition({ path: `${WAF}/rules` });
  assert.equal(r.disposition, 'PREINSTALLED_RUNTIME');
});

test('RBD-W4 waf default / html 判 PREINSTALLED_RUNTIME', () => {
  for (const sub of ['default', 'html']) {
    const r = classifyDisposition({ path: `${WAF}/${sub}` });
    assert.equal(r.disposition, 'PREINSTALLED_RUNTIME', `${sub} 应为 PREINSTALLED_RUNTIME`);
  }
});

test('RBD-W5 waf db 判 EXCLUDED（55 个 sqlite 总 389 行全是程序字典，8 个事件库全 0 行）', () => {
  const r = classifyDisposition({ path: `${WAF}/db` });
  assert.equal(r.disposition, 'EXCLUDED');
});

test('RBD-W6 waf geo 判 REBUILDABLE_DEPENDENCY 且记录来源与校验方式', () => {
  const r = classifyDisposition({ path: `${WAF}/geo` });
  assert.equal(r.disposition, 'REBUILDABLE_DEPENDENCY');
  assert.match(r.rebuild.source, /Geo|geo/);
  assert.match(r.rebuild.verify, /sha256/i);
});

test('RBD-W7 单个 mmdb 文件也判 REBUILDABLE_DEPENDENCY', () => {
  const r = classifyDisposition({ path: `${WAF}/geo/GeoIP.mmdb` });
  assert.equal(r.disposition, 'REBUILDABLE_DEPENDENCY');
});

test('RBD-W8 sites/*/rules/*.json 跟随父级判 RESTORE_REQUIRED（站点级快照，不能按全局默认处理）', () => {
  const r = classifyDisposition({ path: `${WAF}/sites/www.toogel.cn/rules/args.json` });
  assert.equal(r.disposition, 'RESTORE_REQUIRED');
});

// ---------------- RBD-C：挖孔必须赢过预置前缀 ----------------

test('RBD-C1 /opt/1panel/www 判 RESTORE_REQUIRED（虽然 /opt/1panel/db 是预置，但 www 是站点配置）', () => {
  const r = classifyDisposition({ path: '/opt/1panel/www' });
  assert.equal(r.disposition, 'RESTORE_REQUIRED');
  assert.match(r.dispositionReason, /站点|证书|反向代理/);
});

test('RBD-C2 /opt/1panel/www 子路径也判 RESTORE_REQUIRED', () => {
  for (const p of ['/opt/1panel/www/conf.d', '/opt/1panel/www/sites/www.toogel.cn/ssl', '/opt/1panel/www/stream.d']) {
    const r = classifyDisposition({ path: p });
    assert.equal(r.disposition, 'RESTORE_REQUIRED', `${p} 应为 RESTORE_REQUIRED`);
  }
});

test('RBD-C3 /opt/1panel/db 仍是预置（挖孔不能把整个 1panel 变成要备份）', () => {
  const r = classifyDisposition({ path: '/opt/1panel/db/agent.db' });
  assert.equal(r.disposition, 'PREINSTALLED_RUNTIME');
});

// ---------------- RBD-B：判定顺序与计数 ----------------

test('RBD-B1 日志优先于 venv：/x/venv/log 判 EXCLUDED', () => {
  // 判定顺序：EXCLUDED 段先于 REBUILDABLE 段
  const r = classifyDisposition({ path: '/root/app/venv/log' });
  assert.equal(r.disposition, 'EXCLUDED');
});

test('RBD-B2 计数含 0 值（预置 0 条与预置 12 条含义不同）', () => {
  const c = countDispositions([{ disposition: 'RESTORE_REQUIRED' }]);
  assert.deepEqual(Object.keys(c).sort(), [...DISPOSITIONS].sort());
  assert.equal(c.RESTORE_REQUIRED, 1);
  assert.equal(c.PREINSTALLED_RUNTIME, 0);
  assert.equal(c.REBUILDABLE_DEPENDENCY, 0);
  assert.equal(c.EXCLUDED, 0);
});

test('RBD-B3 报告头一行含四类中文标签', () => {
  const line = buildDispositionLines([
    { disposition: 'RESTORE_REQUIRED' },
    { disposition: 'PREINSTALLED_RUNTIME' },
    { disposition: 'PREINSTALLED_RUNTIME' },
    { disposition: 'EXCLUDED' },
  ]);
  assert.match(line, /^职责分布：/);
  assert.match(line, /恢复业务状态 1 条/);
  assert.match(line, /预置运行环境 2 条/);
  assert.match(line, /可重建依赖 0 条/);
  assert.match(line, /已排除 1 条/);
});

test('RBD-B4 计数之和 == 输入长度（RB-1）', () => {
  const items = [
    { disposition: 'RESTORE_REQUIRED' },
    { disposition: 'EXCLUDED' },
    { disposition: 'REBUILDABLE_DEPENDENCY' },
    { disposition: 'PREINSTALLED_RUNTIME' },
    { disposition: 'RESTORE_REQUIRED' },
  ];
  const c = countDispositions(items);
  const sum = Object.values(c).reduce((a, b) => a + b, 0);
  assert.equal(sum, items.length);
});
