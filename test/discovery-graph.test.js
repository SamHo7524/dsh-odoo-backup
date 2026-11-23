import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASSET_CLASSES,
  buildDependencyGraph,
  emptyAssetSet,
} from '../lib/discovery/graph.js';

// ---------------- DG-A：六类资产完整性 ----------------

test('DG-A1 六类资产常量固定且顺序稳定', () => {
  assert.deepEqual(ASSET_CLASSES, ['config', 'data', 'files', 'db', 'api', 'recovery']);
});

test('DG-A2 emptyAssetSet 六类全在，且每类是空数组', () => {
  const s = emptyAssetSet();
  for (const k of ASSET_CLASSES) {
    assert.ok(Array.isArray(s[k]), `${k} 应为数组`);
    assert.equal(s[k].length, 0);
  }
});

test('DG-A3 缺哪类要显式记「未发现」，不能省略行', () => {
  const g = buildDependencyGraph({
    services: [
      {
        service: 'webchat.service',
        modules: ['chatbot_ai_hermes'],
        assets: {
          config: [{ path: '/etc/systemd/system/webchat.service', evidence: ['L4'] }],
          // 只给 config，其余五类缺失
        },
      },
    ],
  });
  const svc = g.services[0];
  for (const k of ASSET_CLASSES) {
    assert.ok(Array.isArray(svc.assets[k]), `${k} 必须存在`);
  }
  assert.equal(svc.assets.config.length, 1);
  assert.equal(svc.assets.data.length, 0);
  // 每条边自带「缺失清单」，报告据此写「未发现」
  assert.ok(svc.missing.includes('data'));
  assert.ok(svc.missing.includes('db'));
});

// ---------------- DG-M：模块关联强度 ----------------

test('DG-M1 显式关联标记 explicit', () => {
  const g = buildDependencyGraph({
    services: [
      { service: 'webchat', modules: ['chatbot_ai_hermes'], link: 'explicit' },
    ],
  });
  assert.equal(g.services[0].link, 'explicit');
});

test('DG-M2 未声明关联强度默认 inferred（不得默认成 explicit）', () => {
  const g = buildDependencyGraph({
    services: [{ service: 'some-svc', modules: ['x'] }],
  });
  assert.equal(g.services[0].link, 'inferred');
});

test('DG-M3 完全无法关联时 link=unknown 且 modules 为空', () => {
  const g = buildDependencyGraph({
    services: [{ service: 'orphan-svc' }],
  });
  assert.equal(g.services[0].link, 'unknown');
  assert.deepEqual(g.services[0].modules, []);
});

// ---------------- DG-R：recovery 必填 ----------------

test('DG-R1 无恢复方式说明的资产写入 recovery 类并标「未知」', () => {
  const g = buildDependencyGraph({
    services: [
      {
        service: 'svc-a',
        assets: {
          data: [{ path: '/opt/a/state.db', evidence: ['L4'] }],
        },
      },
    ],
  });
  const rec = g.services[0].assets.recovery;
  assert.ok(rec.length >= 1, 'recovery 不能为空');
  assert.match(JSON.stringify(rec), /未知|人工确认/);
});

test('DG-R2 明确的恢复方式被原样保留', () => {
  const g = buildDependencyGraph({
    services: [
      {
        service: 'svc-b',
        assets: {
          data: [{ path: '/opt/b/state.db', recovery: '随主包整目录还原' }],
        },
      },
    ],
  });
  const rec = g.services[0].assets.recovery;
  assert.match(JSON.stringify(rec), /整目录还原/);
});

// ---------------- DG-S：api 只留键名与形状 ----------------

test('DG-S1 api 类输出键名与 URL 形状，绝不含值', () => {
  const g = buildDependencyGraph({
    services: [
      {
        service: 'svc-c',
        assets: {
          api: [
            { name: 'DEEPSEEK_API_KEY', shape: 'sk-***', source: 'cs-main/.env' },
            { url: 'https://api.deepseek.com/v1/chat/completions' },
          ],
        },
      },
    ],
  });
  const json = JSON.stringify(g);
  assert.match(json, /DEEPSEEK_API_KEY/);
  assert.match(json, /api\.deepseek\.com/);
  // 不能出现任何真实形态的密钥
  assert.doesNotMatch(json, /sk-[A-Za-z0-9]{20,}/);
});

test('DG-S2 传入疑似密钥值会被抹成 ***', () => {
  const g = buildDependencyGraph({
    services: [
      {
        service: 'svc-d',
        assets: {
          api: [{ name: 'QQ_CLIENT_SECRET', value: 'abcdef0123456789abcdef0123456789' }],
        },
      },
    ],
  });
  const json = JSON.stringify(g);
  assert.doesNotMatch(json, /abcdef0123456789/);
  assert.match(json, /\*\*\*/);
});

// ---------------- DG-G：模块索引 ----------------

test('DG-G1 反向索引：模块 → 它依赖的服务列表', () => {
  const g = buildDependencyGraph({
    services: [
      { service: 'webchat.service', modules: ['chatbot_ai_hermes'] },
      { service: 'hermes-gateway', modules: ['chatbot_ai_hermes', 'web_chat'] },
    ],
  });
  assert.deepEqual(g.byModule.chatbot_ai_hermes.sort(), ['hermes-gateway', 'webchat.service']);
  assert.deepEqual(g.byModule.web_chat, ['hermes-gateway']);
});

test('DG-G2 没有模块关联的服务也进 services，且不进 byModule', () => {
  const g = buildDependencyGraph({
    services: [{ service: 'lonely' }, { service: 'linked', modules: ['m1'] }],
  });
  assert.equal(g.services.length, 2);
  assert.deepEqual(Object.keys(g.byModule), ['m1']);
});
