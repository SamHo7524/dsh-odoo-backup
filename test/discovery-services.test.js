import test from 'node:test';
import assert from 'node:assert/strict';

import {
  serviceShortName,
  portOf,
  portOfUrl,
  buildServices,
  DEFAULT_RECIPES,
} from '../lib/discovery/services.js';
import { buildDependencyGraph } from '../lib/discovery/graph.js';

test('DSV-B1 unit 名去 .service 后缀', () => {
  assert.equal(serviceShortName('webchat.service'), 'webchat');
  assert.equal(serviceShortName('socat-odoo-proxy.service'), 'socat-odoo-proxy');
  assert.equal(serviceShortName(''), '');
});

test('DSV-B2 端口提取：对象与字符串两种形态', () => {
  assert.equal(portOf({ port: 8766 }), 8766);
  assert.equal(portOf('0.0.0.0:8766'), 8766);
  assert.equal(portOf('nonsense'), null);
  assert.equal(portOfUrl('https://www.toogel.cn/webchat/api/chat'), 443);
  assert.equal(portOfUrl('http://127.0.0.1:8766/'), 8766);
});

test('DSV-S1 模块名出现在 unit 名里 → link=explicit', () => {
  const services = buildServices({
    units: [{ name: 'chatbot_ai_hermes.service', workingDirectory: '/opt/x', environmentFile: '' }],
    modules: [{ name: 'chatbot_ai_hermes', official: false }],
  });
  assert.equal(services.length, 1);
  assert.equal(services[0].link, 'explicit');
  assert.deepEqual(services[0].modules, ['chatbot_ai_hermes']);
});

test('DSV-S2 端口对上 → link=inferred，且 evidence 说明凭什么', () => {
  const services = buildServices({
    units: [{ name: 'webchat.service', workingDirectory: '/opt/web_cs', environmentFile: '' }],
    ports: [{ addr: '127.0.0.1:8766', port: 8766, who: 'webchat' }],
    modules: [{ name: 'chatbot_ai_hermes', official: false }],
    config: {
      urls: [{ file: '/opt/web_cs/server.py', value: 'http://127.0.0.1:8766/webchat/api/chat' }],
    },
  });
  const s = services.find((x) => x.service === 'webchat');
  assert.equal(s.link, 'inferred');
  assert.deepEqual(s.modules, ['chatbot_ai_hermes']);
  assert.match(s.evidence.join(' '), /8766/);
});

test('DSV-S3 认不出来就 link=unknown，modules 留空，不编边', () => {
  const services = buildServices({
    units: [{ name: 'socat-odoo-proxy.service', workingDirectory: '', environmentFile: '' }],
    modules: [{ name: 'chatbot_ai_hermes', official: false }],
  });
  const s = services.find((x) => x.service === 'socat-odoo-proxy');
  assert.equal(s.link, 'unknown');
  assert.deepEqual(s.modules, []);
});

test('DSV-S4 同目录巧合不产生关联（只有端口/名称才认）', () => {
  const services = buildServices({
    units: [{ name: 'unrelated.service', workingDirectory: '/opt/web_cs', environmentFile: '' }],
    modules: [{ name: 'chatbot_ai_hermes', official: false }],
  });
  const s = services.find((x) => x.service === 'unrelated');
  assert.equal(s.link, 'unknown');
});

test('DSV-S5 官方模块不参与关联（不让 base/web 之类污染）', () => {
  const services = buildServices({
    units: [{ name: 'web.service', workingDirectory: '/opt/web', environmentFile: '' }],
    modules: [{ name: 'web', official: true }],
  });
  const s = services.find((x) => x.service === 'web');
  assert.equal(s.link, 'unknown');
  assert.deepEqual(s.modules, []);
});

test('DSV-S6 EnvironmentFile 只把键名放进 api 类，不读内容', () => {
  const services = buildServices({
    units: [{ name: 'webchat.service', workingDirectory: '/opt/web_cs', environmentFile: '/root/.hermes/profiles/cs-main/.env' }],
    config: {
      envKeys: [
        { file: '/root/.hermes/profiles/cs-main/.env', key: 'DEEPSEEK_API_KEY' },
        { file: '/root/.hermes/profiles/cs-main/.env', key: 'QQ_CLIENT_SECRET' },
      ],
    },
  });
  const api = services[0].assets.api;
  assert.deepEqual(api.map((a) => a.key).sort(), ['DEEPSEEK_API_KEY', 'QQ_CLIENT_SECRET']);
  for (const a of api) assert.equal(a.shape, '***');
});

test('DSV-S7 web_cs 配方把「venv 未备份 + 模型需联网下载」写进恢复方式', () => {
  const services = buildServices({
    units: [{ name: 'webchat.service', workingDirectory: '/opt/web_cs', environmentFile: '' }],
  });
  const s = services.find((x) => x.service === 'webchat');
  const recText = s.assets.recovery.map((r) => r.action).join(' ');
  assert.match(recText, /重建 venv/);
  assert.match(recText, /重建 FAISS/);
  const emb = s.assets.data.find((d) => d.path === '/opt/web_cs/embeddings/v1');
  assert.ok(emb);
  assert.match(emb.recovery, /781 MiB/);
});

test('DSV-S8 Odoo 自身作为一个服务，四件套 + pg_dump 全在资产里', () => {
  const services = buildServices({
    instance: {
      odooContainer: '1Panel-odoo-kwnb',
      confPath: '/etc/odoo/odoo.conf',
      addonsPath: '/opt/1panel/apps/odoo/odoo19/data/addons',
      dataPath: '/opt/1panel/apps/odoo/odoo19/data/data',
      pydepsPath: '/opt/1panel/apps/odoo/odoo19/data/data/.local',
      dbName: 'tg-odoo',
    },
    modules: [{ name: 'chatbot_ai_hermes', official: false }],
  });
  const odoo = services[0];
  assert.match(odoo.service, /Odoo/);
  assert.equal(odoo.assets.config.length, 1);
  assert.equal(odoo.assets.files.length, 2);
  assert.equal(odoo.assets.db.length, 1);
  assert.match(odoo.assets.recovery[0].action, /odoo_restore/);
});

test('DSV-S9 装配结果能直接被 buildDependencyGraph 消费，且缺类被列出', () => {
  const services = buildServices({
    units: [{ name: 'webchat.service', workingDirectory: '/opt/web_cs', environmentFile: '' }],
  });
  const g = buildDependencyGraph({ services });
  assert.equal(g.services.length, 1);
  const s = g.services[0];
  // web_cs 没有 db 类资产
  assert.ok(s.missing.includes('db'), 'db 类缺失必须出现在 missing 里');
});

test('DSV-S10 没有 recovery 声明的资产会被标成「未知，需人工确认」', () => {
  const services = [
    {
      service: 'mystery',
      modules: [],
      link: 'unknown',
      assets: { config: [], data: [{ path: '/opt/mystery/db.sqlite' }], files: [], db: [], api: [], recovery: [] },
    },
  ];
  const g = buildDependencyGraph({ services });
  const rec = g.services[0].assets.recovery;
  assert.equal(rec.length, 1);
  assert.match(rec[0].action, /未知（需人工确认）/);
  assert.equal(rec[0].source, 'missing');
});

test('DSV-S11 配方表里没有编造的路径（每条都是绝对路径）', () => {
  for (const [name, r] of Object.entries(DEFAULT_RECIPES)) {
    assert.ok(name);
    for (const c of r.config ?? []) assert.match(c.path, /^\//);
    for (const d of r.data ?? []) assert.match(d.path, /^\//);
  }
});
