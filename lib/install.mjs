// Locate PostgreSQL binaries, installing them via the system package manager
// when missing (apt / dnf / yum / apk). Works on generic Linux Node.js hosts.
import fs from 'node:fs';
import path from 'node:path';
import { which, run, capture, fileExists } from './procs.mjs';

const BIN_NAMES = ['postgres', 'initdb', 'pg_ctl', 'psql', 'createdb', 'pg_isready'];

function versionOf(binDir, log) {
  const postgres = path.join(binDir, process.platform === 'win32' ? 'postgres.exe' : 'postgres');
  const out = capture(postgres, ['--version']);
  return out || 'unknown';
}

/** Scan well-known locations for a bin dir containing postgres+initdb. */
export function findBinDir(cfg, log) {
  const candidates = [];
  if (cfg.binDir) candidates.push(path.resolve(cfg.root, cfg.binDir));

  for (const name of BIN_NAMES) {
    const p = which(name);
    if (p) candidates.push(path.dirname(p));
  }

  const roots = ['/usr/lib/postgresql', '/usr/pgsql-17', '/usr/pgsql-16', '/usr/pgsql-15',
    '/usr/pgsql-14', '/usr/pgsql-13', '/usr/local/pgsql/bin', '/usr/lib/postgresql/16/bin',
    '/usr/lib/postgresql/15/bin', '/usr/lib/postgresql/14/bin', '/usr/lib/postgresql/17/bin'];
  candidates.push(...roots);

  // Glob-ish: /usr/lib/postgresql/*/bin and /usr/pgsql-*/bin
  for (const base of ['/usr/lib/postgresql', '/usr/pgsql-17', '/opt/postgres']) {
    try {
      for (const e of fs.readdirSync(base, { withFileTypes: true })) {
        const cand = e.isDirectory() ? path.join(base, e.name, 'bin') : null;
        if (cand) candidates.push(cand);
      }
    } catch { /* missing dir */ }
  }

  // User-space Postgres binaries shipped via npm (embedded-postgres).
  const nmDir = path.join(cfg.root, 'node_modules', '@embedded-postgres');
  try {
    for (const e of fs.readdirSync(nmDir, { withFileTypes: true })) {
      candidates.push(path.join(nmDir, e.name, 'native', 'bin'));
    }
  } catch { /* package not installed */ }
  const seen = new Set();
  const valid = [];
  for (const dir of candidates) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    const hasPostgres = fileExists(path.join(dir, 'postgres')) || fileExists(path.join(dir, 'postgres.exe'));
    const hasInitdb = fileExists(path.join(dir, 'initdb')) || fileExists(path.join(dir, 'initdb.exe'));
    if (hasPostgres && hasInitdb) valid.push(dir);
  }
  if (valid.length === 0) return null;

  // Prefer a dir matching the version pin, else the highest version, else first.
  valid.sort((a, b) => {
    const va = Number((a.match(/(\d+)/) || [0, 0])[1]) || 0;
    const vb = Number((b.match(/(\d+)/) || [0, 0])[1]) || 0;
    return vb - va;
  });
  if (cfg.versionPin) {
    const pinned = valid.find((d) => d.includes(cfg.versionPin));
    if (pinned) return pinned;
    log.warn('install', `PG_VERSION=${cfg.versionPin} requested but only found: ${valid.join(', ')}`);
  }
  return valid[0];
}

function detectPkgManager(log) {
  for (const [bin, id] of [['apt-get', 'apt'], ['dnf', 'dnf'], ['yum', 'yum'], ['apk', 'apk'], ['zypper', 'zypper']]) {
    if (which(bin)) return id;
  }
  log.warn('install', 'no supported package manager found (apt-get/dnf/yum/apk/zypper)');
  return null;
}

async function installWith(cfg, pm, log) {
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  switch (pm) {
    case 'apt': {
      await run('apt-get', ['update', '-y'], { log, tag: 'apt', env });
      // Honor PG_VERSION: distro postgresql meta may be older than the primary.
      const pkgs = cfg.versionPin
        ? [`postgresql-${cfg.versionPin}`, `postgresql-client-${cfg.versionPin}`, 'openssl']
        : ['postgresql', 'openssl'];
      try {
        await run('apt-get', ['install', '-y', ...pkgs], { log, tag: 'apt', env, timeoutMs: 15 * 60 * 1000 });
      } catch (error) {
        if (!cfg.versionPin) throw error;
        log.warn('install', `postgresql-${cfg.versionPin} unavailable, falling back to distro postgresql`);
        await run('apt-get', ['install', '-y', 'postgresql', 'openssl'], { log, tag: 'apt', env, timeoutMs: 15 * 60 * 1000 });
      }
      break;
    }
    case 'dnf':
    case 'yum': {
      const bin = pm;
      await run(bin, ['install', '-y', 'postgresql-server', 'postgresql', 'openssl'], { log, tag: pm, env, timeoutMs: 15 * 60 * 1000 });
      break;
    }
    case 'apk':
      await run('apk', ['add', '--no-cache', 'postgresql', 'openssl'], { log, tag: 'apk', env, timeoutMs: 15 * 60 * 1000 });
      break;
    case 'zypper':
      await run('zypper', ['--non-interactive', 'install', '-y', 'postgresql-server', 'postgresql', 'openssl'], { log, tag: 'zypper', env, timeoutMs: 15 * 60 * 1000 });
      break;
    default:
      throw new Error(`unsupported package manager: ${pm}`);
  }
}

/**
 * Ensure PostgreSQL binaries exist. Returns { binDir, version }.
 * Throws with actionable instructions if installation is impossible.
 */
export async function ensurePostgres(cfg, log) {
  let binDir = findBinDir(cfg, log);
  if (binDir) {
    log.info('install', `found PostgreSQL binaries in ${binDir} (${versionOf(binDir, log)})`);
    return { binDir, version: versionOf(binDir, log) };
  }

  log.info('install', 'PostgreSQL binaries not found — attempting installation');
  if (cfg.installMode === 'never') {
    throw new Error('PG_INSTALL=never but no PostgreSQL binaries were found on this system.');
  }
  if (cfg.isRoot === false && process.platform === 'linux') {
    log.warn('install', 'not running as root; package installation may fail. Set PG_BIN to a postgres bin dir if you manage it yourself.');
  }

  const pm = detectPkgManager(log);
  if (!pm) {
    throw new Error(
      'Could not find PostgreSQL and no supported package manager was detected.\n' +
      'Install PostgreSQL manually and set PG_BIN to its bin directory (the folder containing initdb/postgres/psql).',
    );
  }
  log.info('install', `installing PostgreSQL via ${pm}`);
  await installWith(cfg, pm, log);

  binDir = findBinDir(cfg, log);
  if (!binDir) {
    throw new Error('Package install finished but PostgreSQL binaries still could not be located. Set PG_BIN explicitly.');
  }
  const version = versionOf(binDir, log);
  log.info('install', `PostgreSQL ready: ${version} at ${binDir}`);
  return { binDir, version };
}

/** Locate a helper binary (openssl, initdb helpers) — prefers system PATH. */
export function findTool(name, binDir) {
  return which(name) || (binDir ? path.join(binDir, name) : null);
}
