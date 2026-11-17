// Central configuration loader. Reads .env (Node 22 loadEnvFile) then process.env.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function tryLoadDotEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  try {
    process.loadEnvFile(envPath);
  } catch (err) {
    console.warn(`[config] could not parse .env: ${err.message}`);
  }
}

const str = (v, dflt = '') => {
  const s = String(v ?? '').trim();
  return s === '' ? dflt : s;
};

const int = (v, dflt, { min = 0, max = 65535 } = {}) => {
  const n = Number.parseInt(String(v ?? ''), 10);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(Math.max(n, min), max);
};

const bool = (v, dflt = false) => {
  const s = String(v ?? '').trim().toLowerCase();
  if (s === '') return dflt;
  return ['1', 'true', 'yes', 'on'].includes(s);
};

// Postgres memory values: digits optionally followed by kB/MB/GB/TB (case-insensitive).
const MEM_RE = /^\d+(\.\d+)?\s*(kB|MB|GB|TB|B)?$/i;
function mem(v, dflt) {
  const s = str(v);
  if (s === '') return dflt;
  if (!MEM_RE.test(s)) {
    console.warn(`[config] invalid memory value "${s}", using default ${dflt}`);
    return dflt;
  }
  return s.replace(/\s+/g, '').toUpperCase();
}

const resolvePath = (v) => {
  const s = str(v);
  return s ? path.resolve(ROOT, s) : '';
};

export function loadConfig() {
  tryLoadDotEnv();

  const dataDir = path.resolve(ROOT, str(process.env.PG_DATA, './data'));
  const ssl = str(process.env.PG_SSL, 'off').toLowerCase();
  if (!['on', 'off'].includes(ssl)) {
    console.warn(`[config] PG_SSL must be "on" or "off" (got "${ssl}"); defaulting to off`);
  }

  return {
    root: ROOT,
    port: int(process.env.PG_PORT, 25204, { min: 1, max: 65535 }),
    superuser: str(process.env.PG_SUPERUSER, 'postgres'),
    password: str(process.env.PG_PASSWORD),
    databases: str(process.env.PG_DATABASE, 'postgres')
      .split(',').map((s) => s.trim()).filter(Boolean),
    listen: str(process.env.PG_LISTEN, '*'),
    allowedCidrs: str(process.env.PG_ALLOWED_CIDRS, '0.0.0.0/0,::/0')
      .split(',').map((s) => s.trim()).filter(Boolean),
    socketDir: str(process.env.PG_SOCKET_DIR, '/tmp'),
    ssl: ssl === 'on' ? 'on' : 'off',
    sslCn: str(process.env.PG_SSL_CN),
    sslDays: int(process.env.PG_SSL_DAYS, 825, { min: 1, max: 36500 }),
    sslMinVersion: str(process.env.PG_SSL_MIN_VERSION, 'TLSv1.2'),
    sslCertFile: resolvePath(process.env.PG_SSL_CERT_FILE),
    sslKeyFile: resolvePath(process.env.PG_SSL_KEY_FILE),
    sharedBuffers: mem(process.env.PG_SHARED_BUFFERS, '128MB'),
    effectiveCacheSize: mem(process.env.PG_EFFECTIVE_CACHE_SIZE, '512MB'),
    workMem: mem(process.env.PG_WORK_MEM, '4MB'),
    maintenanceWorkMem: mem(process.env.PG_MAINTENANCE_WORK_MEM, '64MB'),
    maxConnections: int(process.env.PG_MAX_CONNECTIONS, 100, { min: 1, max: 10000 }),
    maxWalSize: mem(process.env.PG_MAX_WAL_SIZE, '1GB'),
    dataDir,
    binDir: str(process.env.PG_BIN),
    versionPin: str(process.env.PG_VERSION),
    installMode: str(process.env.PG_INSTALL, 'auto').toLowerCase(),
    osUser: str(process.env.PG_OS_USER, process.getuid?.() === 0 ? 'postgres' : (process.env.USER || process.env.USERNAME || 'postgres')),
    healthPort: int(process.env.HEALTH_PORT, 0, { min: 0, max: 65535 }),
    sslmode: str(process.env.PG_SSLMODE, 'prefer'),
    isRoot: typeof process.getuid === 'function' && process.getuid() === 0,
    // Replica mode: when PG_REPLICA_HOST is set, the data directory is seeded
    // with pg_basebackup from that primary instead of initdb, and the server
    // runs as a read-only streaming standby. Database/role bootstrap is skipped.
    replica: str(process.env.PG_REPLICA_HOST)
      ? {
          host: str(process.env.PG_REPLICA_HOST),
          port: int(process.env.PG_REPLICA_PORT, 5432, { min: 1, max: 65535 }),
          user: str(process.env.PG_REPLICA_USER, 'postgres'),
          password: str(process.env.PG_REPLICA_PASSWORD),
          slot: str(process.env.PG_REPLICA_SLOT, 'veyra_eu_slot'),
          database: str(process.env.PG_REPLICA_DB, 'postgres'),
        }
      : null,
  };
}
