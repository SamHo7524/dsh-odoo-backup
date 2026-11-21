/**
 * v0.2.2 Task 4 — UI「额外路径」编辑器契约
 *
 * 目标：服务器卡片内的额外路径编辑器复用既有 saveServers（不引第二条写通道），
 * 不依赖 window.prompt，排除模式输入存在，且保存后 server 对象带 extraPaths。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../client.js', import.meta.url), 'utf8');

// ---- 与 client-add-server.test.js 相同的渲染替身 ----
function createElement(type, props, ...children) {
  return { type, props: props ?? {}, children: children.flat(Infinity) };
}
let hooks = [];
let cursor = 0;
const useState = (init) => {
  const i = cursor++;
  if (i >= hooks.length) hooks[i] = typeof init === 'function' ? init() : init;
  return [hooks[i], (v) => { hooks[i] = typeof v === 'function' ? v(hooks[i]) : v; }];
};
const useCallback = (fn) => fn;
const useEffect = () => {};
const useRef = (init) => ({ current: init });
const useSyncExternalStore = (subscribe, getSnapshot) => getSnapshot();

function expand(node) {
  if (node == null || node === false) return node;
  if (Array.isArray(node)) return node.map(expand);
  if (typeof node === 'string' || typeof node === 'number') return node;
  if (typeof node.type === 'function') return expand(node.type({ ...node.props, children: node.children }));
  return { ...node, children: expand(node.children ?? []) };
}
function findAll(node, pred, out = []) {
  if (node == null || node === false) return out;
  if (Array.isArray(node)) { node.forEach((n) => findAll(n, pred, out)); return out; }
  if (node.type && pred(node)) out.push(node);
  if (node.type) findAll(node.children, pred, out);
  return out;
}
function texts(node, out = []) {
  if (node == null || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out; }
  if (Array.isArray(node)) { node.forEach((n) => texts(n, out)); return out; }
  if (node.type) texts(node.children, out);
  return out;
}
function makeScope(initial = { servers: [] }) {
  let snap = { status: 'ready', writable: true, value: initial };
  const listeners = new Set();
  const writes = [];
  return {
    writes,
    getSnapshot: () => snap,
    subscribe: (fn) => { listeners.add(fn); return () => listeners.delete(fn); },
    set: async (field, value) => {
      writes.push([field, value]);
      snap = { ...snap, value: { ...snap.value, [field]: value } };
      listeners.forEach((f) => f());
      return true;
    },
    unset: async () => true,
  };
}
function makeForms(servedNs, scope) {
  return {
    describe: () => ({ getSnapshot: () => ({ view: { namespaces: servedNs ? [{ ns: servedNs }] : [] } }) }),
    get: (ns) => scope,
    whileServed: (candidates, register) => {
      const off = register(new Set(candidates.filter((c) => c === servedNs)));
      return () => { if (typeof off === 'function') off(); };
    },
  };
}
function loadClient({ configForms } = {}) {
  let registered;
  const win = {
    __ModuleLoader__: { load: (d) => { registered = d; } },
    prompt: () => { throw new Error('window.prompt is not supported in Electron'); },
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
  const factoryResult = registered.factory((name) => {
    if (name === 'react') return { createElement, useState, useCallback, useEffect, useRef, useSyncExternalStore };
    throw new Error('unknown module ' + name);
  });
  const registrations = [];
  let injectCallbacks = [];
  const ctx = {
    reflect: { get: () => ({ bind: () => (k) => k }) },
    get: (name) => (name === 'configForms' ? configForms : undefined),
    effect: (fn) => { const d = fn(); return d ?? (() => {}); },
    inject: (services, cb) => { if (services.includes('configForms')) injectCallbacks.push(cb); },
    slots: {
      inject: (key, cb) => { const e = cb(); return () => { if (typeof e === 'function') e(); }; },
      register: (opts, comp) => {
        const entry = { opts, comp, live: true };
        registrations.push(entry);
        return () => { entry.live = false; };
      },
    },
  };
  factoryResult.apply(ctx);
  return {
    page: () => registrations.filter((r) => r.live && r.opts.name === 'settings.section')[0],
    deliverLateService: (service) => injectCallbacks.forEach((cb) => cb({ configForms: service })),
  };
}
function mount(comp, props) {
  hooks = [];
  cursor = 0;
  return expand(comp(props));
}
function render(comp, props) {
  cursor = 0;
  return expand(comp(props));
}

// ------------------------------------------------------------------ 源码契约

test('CXP-UI1 client.js 源码含「额外路径」区块与 extraPaths 字段', () => {
  assert.match(src, /额外路径/, '服务器卡片应有额外路径区块');
  assert.match(src, /extraPaths/, '额外路径行应使用 extraPaths 字段');
});

test('CXP-UI2 额外路径保存复用既有 saveServers，不新增第二条写通道', () => {
  // 额外路径的保存必须与服务器保存共用 saveServers；不得出现针对 extraPaths 的新 fetch 路由。
  assert.match(src, /saveServers/, '必须有 saveServers');
  // 排除新增的专用写路由：只匹配 fetch 调用里引号包裹、且路径含 extra 的字面量。
  assert.doesNotMatch(src, /fetch\([^)]*['"`]\/[^'"`]*extra/,
    '不得为额外路径新增后端路由，应复用 saveServers');
});

test('CXP-UI3 额外路径行含「排除模式」输入', () => {
  assert.match(src, /排除/, '额外路径行应有排除模式输入');
});

// ------------------------------------------------------------------ 交互契约

test('CXP-UI4 添加一行后 rows 增 1', () => {
  const scope = makeScope();
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.page();

  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  const addBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0];
  addBtn.props.onClick();

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const addRowBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加额外路径')))[0];
  assert.ok(addRowBtn, '内联表单应提供「添加额外路径」按钮');
  addRowBtn.props.onClick();

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const rows = findAll(tree, (n) => n.type === 'input'
    && /^额外路径名称/.test(String(n.props['aria-label'] ?? '')));
  assert.equal(rows.length, 1, '点击「添加额外路径」后应出现 1 行（名称输入框计数）');
});

test('CXP-UI5 保存后写入的 server 对象含 extraPaths', async () => {
  const scope = makeScope();
  const h = loadClient({ configForms: makeForms('include:odoo-backup', scope) });
  const reg = h.page();

  let tree = mount(reg.comp, reg.opts.inject?.() ?? {});
  findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加服务器')))[0].props.onClick();

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x.includes('添加额外路径')))[0].props.onClick();

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  let inputs = findAll(tree, (n) => n.type === 'input');
  // 真实 React 每次 onChange 都会重渲染；这里每改一个字段就重取一次输入框，
  // 否则第二次 onChange 会用旧闭包里的 draft 覆盖第一次的值（ADD-3 的同款教训）。
  const setField = (re, value) => {
    const input = findAll(tree, (n) => n.type === 'input'
      && new RegExp('^' + re).test(String(n.props['aria-label'] ?? '')))[0];
    assert.ok(input, `应能定位 aria-label 以 ${re} 开头的输入框`);
    input.props.onChange({ target: { value } });
    tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  };
  setField('服务器名称', 'toogel');
  setField('主机地址', '47.121.205.143');
  setField('额外路径名称', 'vault');
  setField('额外路径路径', '/root/Documents/Obsidian Vault');
  setField('额外路径排除', '.git, .obsidian');

  tree = render(reg.comp, { ...(reg.opts.inject?.() ?? {}) });
  const saveBtn = findAll(tree, (n) => n.type === 'button' && texts(n).some((x) => x === '保存'))[0];
  assert.ok(saveBtn, '应有保存按钮');
  assert.ok(!saveBtn.props.disabled, '填好必填项后保存按钮应可点击');
  await saveBtn.props.onClick();

  assert.equal(scope.writes.length, 1, '应写入一次配置');
  const saved = scope.writes[0][1][0];
  assert.equal(saved.name, 'toogel');
  assert.deepEqual(saved.extraPaths, [{
    name: 'vault',
    path: '/root/Documents/Obsidian Vault',
    exclude: ['.git', '.obsidian'],
    maxBytes: null,
  }], '保存时必须把额外路径行序列化为 extraPaths 交给 saveServers');
});
