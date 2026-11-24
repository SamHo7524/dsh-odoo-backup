import { pathToFileURL } from 'node:url';

const PLUGIN = 'C:/Users/Ho/.dsh/profiles/desktop/node_modules/@local/dsh-odoo-backup';
const { packExtras } = await import(pathToFileURL(`${PLUGIN}/lib/extras-runner.js`).href);

const server = {
  name: 'toogel',
  host: '47.121.205.143',
  port: 22,
  user: 'root',
  keyPath: 'H:/odoo/key/odoo-backup',
  pinnedFingerprint: 'SHA256:oSJdaZyQHzXS8tLQq4kwlrR6J1KqAbJfC4x93WnOJFQ',
};

const extras = [
  {
    name: 'waf-data',
    path: '/opt/1panel/apps/openresty/openresty/1pwaf/data',
    exclude: ['./geo'],
    maxBytes: null,
  },
];

const res = await packExtras({
  server,
  workDir: '/tmp/drill-pack',
  ts: 'waf1',
  compressor: 'zstd',
  extras,
  dumpBytes: 0,
  onProgress: (p) => console.log('PROG', p.phase, p.percent, p.message ?? ''),
});

console.log('PACK_OK', JSON.stringify(res, null, 2));
