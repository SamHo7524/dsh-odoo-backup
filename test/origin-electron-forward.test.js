/**
 * 同源校验在 Electron 桌面端（dsh-app:// 协议转发）下的行为验证。
 *
 * 背景：DSH 0.2.2-rc.3 的宿主 forwardWebRequest 删除了 origin/host/cookie/sec-fetch-site
 * 四个请求头且不再补回 origin（旧版 lib/web-document.js:162 有
 * `headers.set("origin", target.origin)`）。于是桌面端转发到 Host 的请求只剩
 * Chromium 自动生成的 `Referer: dsh-app://app/…`，插件原来的
 * `new URL(referer).host === host` 判断永远为假 → 桌面端保存服务器必 403。
 *
 * 契约：Referer 为 dsh-app://app 且来源是回环地址时视为同源（协议层只放行
 * dsh-app://app 才能触发转发）；其余组合保持原来的严格判断。
 */
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { normalizeServerRole } from '../lib/server-role.js';

const hostSrc = readFileSync(new URL('../index.js', import.meta.url), 'utf8');

function loadHandler() {
  const start = hostSrc.indexOf('async function handleUiRequest');
  assert.ok(start > 0, 'index.js 应包含 handleUiRequest');
  const body = hostSrc.slice(start);
  const code = `return (${body.replace(/^async function handleUiRequest/, 'async function')})`;
  // v0.4.0：/save-servers 现在调用 normalizeServerRole 做用途校验。
  // eslint-disable-next-line no-new-func
  return new Function('normalizeServerRole', code)(normalizeServerRole);
}

function makeRes() {
  const out = { statusCode: 0, headers: {}, body: '' };
  return {
    out,
    set statusCode(v) { out.statusCode = v; },
    get statusCode() { return out.statusCode; },
    setHeader(k, v) { out.headers[k] = v; },
    end(b) { out.body = b; },
  };
}

function makeReq({ method = 'POST', url = '/odoo-backup/save-servers', body = {}, origin, referer, remoteAddress = '127.0.0.1' } = {}) {
  const payload = JSON.stringify(body);
  const headers = { host: '127.0.0.1:15822' };
  if (origin) headers.origin = origin;
  if (referer) headers.referer = referer;
  return {
    method,
    url,
    headers,
    socket: { remoteAddress },
    async *[Symbol.asyncIterator]() { yield Buffer.from(payload); },
  };
}

async function drive(reqOpts) {
  const handler = loadHandler();
  const calls = [];
  const settings = { async update(ns, patch) { calls.push([ns, patch]); } };
  const res = makeRes();
  await handler({
    req: makeReq(reqOpts),
    res,
    config: { servers: [] },
    service: {},
    tokenStore: {},
    settings,
    entryId: 'odoo-backup',
  });
  return { res, calls };
}

test('ORIGIN-E1 桌面端真实转发头（无 origin + Referer dsh-app://app/ + 回环）放行', async () => {
  const { res, calls } = await drive({
    referer: 'dsh-app://app/settings',
    body: { servers: [{ name: 'toogel', host: '47.121.205.143' }] },
  });
  assert.equal(res.out.statusCode, 200, `应 200，实际 ${res.out.statusCode}: ${res.out.body}`);
  assert.equal(JSON.parse(res.out.body).ok, true);
  assert.equal(calls.length, 1, '必须真正写入配置');
});

test('ORIGIN-E2 伪造 dsh-app Referer 但来源非回环，仍拒绝', async () => {
  const { res, calls } = await drive({
    referer: 'dsh-app://app/settings',
    remoteAddress: '203.0.113.7',
    body: { servers: [{ name: 'x', host: 'h' }] },
  });
  assert.equal(res.out.statusCode, 403, '非回环来源必须拒绝');
  assert.equal(calls.length, 0, '拒绝时不得写入');
});

test('ORIGIN-E3 外部 Referer 仍拒绝（安全边界不回退）', async () => {
  const { res, calls } = await drive({
    referer: 'https://evil.example.com/',
    body: { servers: [{ name: 'x', host: 'h' }] },
  });
  assert.equal(res.out.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('ORIGIN-E4 dsh-app://app 作为 Origin 出现时仍拒绝（协议层不应放出，插件不背锅）', async () => {
  const { res, calls } = await drive({
    origin: 'dsh-app://app',
    body: { servers: [{ name: 'x', host: 'h' }] },
  });
  assert.equal(res.out.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('ORIGIN-E5 浏览器同源 Origin 仍放行（回归）', async () => {
  const { res, calls } = await drive({
    origin: 'http://127.0.0.1:15822',
    body: { servers: [{ name: 'toogel', host: 'h' }] },
  });
  assert.equal(res.out.statusCode, 200, `应 200，实际 ${res.out.statusCode}: ${res.out.body}`);
  assert.equal(calls.length, 1);
});

test('ORIGIN-E6 无 Origin/Referer + 回环仍放行（本机 curl 场景，回归）', async () => {
  const { res, calls } = await drive({ body: { servers: [{ name: 'toogel', host: 'h' }] } });
  assert.equal(res.out.statusCode, 200);
  assert.equal(calls.length, 1);
});

test('ORIGIN-E7 无 Origin/Referer + 非回环仍拒绝（回归）', async () => {
  const { res, calls } = await drive({
    remoteAddress: '203.0.113.7',
    body: { servers: [{ name: 'x', host: 'h' }] },
  });
  assert.equal(res.out.statusCode, 403);
  assert.equal(calls.length, 0);
});

test('ORIGIN-E8 畸形 Referer 不抛异常，按拒绝处理', async () => {
  const { res } = await drive({
    referer: '::::not a url::::',
    body: { servers: [{ name: 'x', host: 'h' }] },
  });
  assert.equal(res.out.statusCode, 403);
});
