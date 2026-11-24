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
    name: 'attendance-system',
    path: '/root/attendance-system',
    exclude: ['./venv', './__pycache__', './.pytest_cache', './attendance.db', './attendance.db-shm', './attendance.db-wal'],
    maxBytes: null,
  },
];

const res = await packExtras({
  server,
  workDir: '/tmp/drill-pack',
  ts: 'drill1',
  compressor: 'zstd',
  extras,
  dumpBytes: 0,
  onProgress: (p) => console.log('PROG', p.phase, p.percent, p.message ?? ''),
});

console.log('PACK_OK', JSON.stringify(res, null, 2));
