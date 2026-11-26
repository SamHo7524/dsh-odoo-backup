/**
 * 真渲染断言：恢复页 HTML 里不能出现备份源，备份页 HTML 里不能出现恢复目标。
 * 源码 grep 只能证明「写了过滤」，不能证明「页面输出里没有生产服务器」——
 * 本项目已有三次「静态断言全绿但功能没生效」（M26/M67/M82）。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const PROFILE = 'C:/Users/Ho/.dsh/profiles/desktop';
const require = createRequire(PROFILE + '/package.json');
const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

let React;
let renderToStaticMarkup;
try {
  React = require('react');
  ({ renderToStaticMarkup } = require('react-dom/server'));
} catch (e) {
  console.log('SKIP: react/react-dom not resolvable from profile:', e.message.slice(0, 120));
  process.exit(0);
}

const SERVERS = [
  { name: 'toogel', host: '47.121.205.143', user: 'root', role: 'backup' },
  { name: 'odoo.toogel.cn', host: '134.175.51.9', user: 'root', role: 'restore' },
];

const SNAPSHOT = { value: { servers: SERVERS } };

function makeScope() {
  return {
    getSnapshot: () => SNAPSHOT,
    subscribe: () => () => {},
    set: async () => {},
  };
}

/** 用假 configForms 让组件拿到 scope，再按指定 tab 渲染。 */
function renderTab(initialTab) {
  let registered;
  const win = {
    __ModuleLoader__: { load: (d) => { registered = d; } },
    prompt: () => null,
    confirm: () => true,
    setTimeout: () => 0,
  };
  const realST = global.setTimeout;
  const realCT = global.clearTimeout;
  global.setTimeout = () => 0;
  global.clearTimeout = () => {};
  try {
    new Function('window', 'fetch', src)(win, async () => ({ json: async () => ({ ok: true }) }));
  } finally {
    global.setTimeout = realST;
    global.clearTimeout = realCT;
  }

  const scope = makeScope();
  const forms = {
    get: () => scope,
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: [{ ns: 'odoo-backup' }] } }) }),
  };
  let reg = null;
  const ctx = {
    reflect: { get: () => ({ bind: () => (k) => k }) },
    get: (name) => (name === 'configForms' ? forms : undefined),
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    slots: {
      inject: (key, cb) => { cb(); return () => {}; },
      register: (opts, comp) => { reg = { opts, comp }; return () => {}; },
    },
  };
  registered.factory((name) => {
    if (name === 'react') return React;
    throw new Error('unknown module ' + name);
  }).apply(ctx);

  assert.ok(reg, '必须注册出设置页组件');
  const injected = reg.opts.inject?.() ?? {};
  return renderToStaticMarkup(React.createElement(reg.comp, { ...injected, initialTab }));
}

// odoo.toogel.cn 本身含子串 toogel，必须精确匹配「独立单词 toogel」。
const BARE_TOOGEL = /(^|[^.\w])toogel(?![.\w])/;

test('RR-1 恢复页渲染结果不含备份源、含恢复目标', () => {
  const html = renderTab('restore');
  assert.match(html, /odoo\.toogel\.cn/, '恢复目标必须出现');
  assert.doesNotMatch(html, BARE_TOOGEL, '备份源 toogel 绝不能出现在恢复页');
});

test('RR-2 备份页渲染结果不含恢复目标、含备份源', () => {
  const html = renderTab('backup');
  assert.match(html, BARE_TOOGEL, '备份源必须出现');
  assert.doesNotMatch(html, /odoo\.toogel\.cn/, '恢复目标绝不能出现在备份页');
});

test('RR-3 恢复页空态：有恢复目标时不出现空态文案', () => {
  const html = renderTab('restore');
  assert.doesNotMatch(html, /尚未配置「恢复目标」服务器/);
});

test('RR-4 备份页空态：只有恢复目标时提示去服务器页', () => {
  SNAPSHOT.value.servers = [{ name: 'odoo.toogel.cn', host: '134.175.51.9', user: 'root', role: 'restore' }];
  try {
    const html = renderTab('backup');
    assert.match(html, /当前没有「备份服务器」/);
    assert.doesNotMatch(html, /odoo\.toogel\.cn/);
  } finally {
    SNAPSHOT.value.servers = SERVERS;
  }
});
