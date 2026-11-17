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
  if (cfg.replica) {
    const withBackup = valid.find((d) =>
      fileExists(path.join(d, 'pg_basebackup')) || fileExists(path.join(d, 'pg_basebackup.exe')));
    if (withBackup) return withBackup;
    log.warn('install', 'replica mode needs pg_basebackup — none of the found bin dirs ship it');
  }
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


function debianCodename() {
  try {
    const osr = fs.readFileSync('/etc/os-release', 'utf8');
    const m = osr.match(/VERSION_CODENAME="?([^"\n]+)"?/) || osr.match(/VERSION="([^"]+)"/);
    return m ? m[1].trim().split(' ')[0].toLowerCase() : null;
  } catch {
    return null;
  }
}

/**
 * Unprivileged PostgreSQL install for containers without root: resolves the
 * PGDG apt repo into a private lists/cache dir, downloads .debs only, then
 * extracts them under <root>/.pg-debs/root. Returns the extraction prefix.
 */
async function installViaDebDownload(cfg, log) {
  if (process.platform !== 'linux') throw new Error('deb download fallback only supports linux');
  if (!which('apt-get') || !which('dpkg-deb')) throw new Error('apt-get/dpkg-deb not found');
  const codename = debianCodename();
  if (!codename) throw new Error('cannot determine distro codename for PGDG repo');
  const suite = `${codename}-pgdg`;
  const work = path.join(cfg.root, '.pg-debs');
  const lists = path.join(work, 'lists');
  const cache = path.join(work, 'cache');
  const prefix = path.join(work, 'root');
  const srcFile = path.join(work, 'pgdg.list');
  for (const d of [lists, path.join(lists, 'partial'), cache, path.join(cache, 'archives', 'partial'), prefix]) {
    fs.mkdirSync(d, { recursive: true });
  }
  // Dependency closure (locales, libssl, gssapi, ...) lives in the distro
  // archive, not PGDG — include it so apt can resolve Depends.
  let distroId = null;
  try {
    distroId = (fs.readFileSync('/etc/os-release', 'utf8').match(/^ID="?([^"\n]+)/m) || [])[1] || null;
  } catch { /* ignore */ }
  const srcLines = [];
  if (distroId === 'debian') {
    srcLines.push(`deb [trusted=yes] http://deb.debian.org/debian ${codename} main contrib non-free non-free-firmware`);
    srcLines.push(`deb [trusted=yes] http://deb.debian.org/debian-security ${codename}-security main contrib non-free non-free-firmware`);
  } else if (distroId) {
    const ubuntuVer = (fs.readFileSync('/etc/os-release', 'utf8').match(/^VERSION_ID="?([0-9.]+)/m) || [])[1];
    if (ubuntuVer) {
      const u = ubuntuVer.split('.')[0];
      srcLines.push(`deb [trusted=yes] http://archive.ubuntu.com/ubuntu ${codename} main restricted universe multiverse`);
      srcLines.push(`deb [trusted=yes] http://archive.ubuntu.com/ubuntu ${codename}-updates main restricted universe multiverse`);
      srcLines.push(`deb [trusted=yes] http://archive.ubuntu.com/ubuntu ${codename}-security main restricted universe multiverse`);
    }
  }
  srcLines.push(`deb [trusted=yes] http://apt.postgresql.org/pub/repos/apt ${suite} main`);
  fs.writeFileSync(srcFile, srcLines.join('\n') + '\n');
  const statusFile = '/var/lib/dpkg/status';
  const aptOpts = [
    '-o', `Dir::State::Lists=${lists}`,
    '-o', `Dir::Cache=${cache}`,
    '-o', 'Dir::Etc::sourcelist=' + srcFile,
    '-o', 'Dir::Etc::sourceparts=-',
    '-o', 'APT::Get::List-Cleanup=0',
    '-o', 'Debug::NoLocking=1',
  ];
  if (!fileExists(statusFile)) {
    const emptyStatus = path.join(work, 'status');
    fs.writeFileSync(emptyStatus, '');
    aptOpts.push('-o', 'Dir::State::status=' + emptyStatus);
  }
  const env = { ...process.env, DEBIAN_FRONTEND: 'noninteractive' };
  const pkg = cfg.versionPin ? `postgresql-${cfg.versionPin}` : 'postgresql';
  log.info('install', `fetching ${pkg} from PGDG (${suite}) without root`);
  await run('apt-get', [...aptOpts, 'update'], { log, tag: 'apt', env, timeoutMs: 5 * 60 * 1000 });
  await run('apt-get', [...aptOpts, '-o', 'APT::Get::Download-Only=true', 'install', '-y', '--no-install-recommends', pkg], { log, tag: 'apt', env, timeoutMs: 15 * 60 * 1000 });
  const archDir = path.join(cache, 'archives');
  const debs = fs.readdirSync(archDir).filter((f) => f.endsWith('.deb'));
  if (debs.length === 0) throw new Error('apt download produced no .deb packages');
  for (const d of debs) {
    await run('dpkg-deb', ['-x', path.join(archDir, d), prefix], { log, tag: 'dpkg-deb', env });
  }
  log.info('install', `extracted ${debs.length} packages to ${prefix}`);
  return prefix;
}

/** Copy pg_basebackup (and lib deps path) from an extracted .deb prefix into the embedded bin dir. */
function graftDebBinaries(cfg, prefix, log) {
  const pgRoot = path.join(prefix, 'usr', 'lib', 'postgresql');
  let binDir = null;
  try {
    for (const e of fs.readdirSync(pgRoot, { withFileTypes: true })) {
      const cand = path.join(pgRoot, e.name, 'bin', process.platform === 'win32' ? 'pg_basebackup.exe' : 'pg_basebackup');
      if (fileExists(cand)) { binDir = path.dirname(cand); break; }
    }
  } catch { /* none */ }
  if (!binDir) {
    log.warn('install', 'pg_basebackup not found in extracted debs');
    return;
  }
  const embedded = findBinDir({ ...cfg, replica: null }, log);
  if (!embedded) {
    log.warn('install', 'no writable postgres bin dir to graft pg_basebackup into');
    return;
  }
  const src = path.join(binDir, 'pg_basebackup');
  const dst = path.join(embedded, 'pg_basebackup');
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
  const libDirs = [
    path.join(prefix, 'usr', 'lib', 'x86_64-linux-gnu'),
    path.join(prefix, 'lib', 'x86_64-linux-gnu'),
    path.join(prefix, 'usr', 'lib', 'postgresql', path.basename(path.dirname(binDir)), 'lib'),
  ].filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
  if (libDirs.length) {
    const cur = process.env.LD_LIBRARY_PATH || '';
    const missing = libDirs.filter((d) => !cur.split(':').includes(d));
    if (missing.length) process.env.LD_LIBRARY_PATH = [...missing, cur].filter(Boolean).join(':');
  }
  log.info('install', `grafted pg_basebackup into ${embedded} (LD_LIBRARY_PATH += ${libDirs.length} dirs)`);
}
/**
 * Ensure PostgreSQL binaries exist. Returns { binDir, version }.
 * Throws with actionable instructions if installation is impossible.
 */
export async function ensurePostgres(cfg, log) {
  let binDir = findBinDir(cfg, log);
  const hasBackup = (d) => d && (fileExists(path.join(d, 'pg_basebackup')) || fileExists(path.join(d, 'pg_basebackup.exe')));
  if (binDir && cfg.replica && !hasBackup(binDir)) {
    log.warn('install', `${binDir} lacks pg_basebackup required for replica mode — installing system PostgreSQL`);
    binDir = null;
  }
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
  let debPrefix = null;
  try {
    await installWith(cfg, pm, log);
  } catch (error) {
    log.warn('install', `package install failed: ${error.message}`);
    debPrefix = await installViaDebDownload(cfg, log);
  }
  if (debPrefix) graftDebBinaries(cfg, debPrefix, log);

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
