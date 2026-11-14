// Small async process helpers: run a command while streaming output to the
// logger, plus helpers for running commands as the postgres OS user when the
// app itself runs as root (postgres refuses to run as root).
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export function which(bin) {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const out = spawnSync(cmd, [bin], { encoding: 'utf8' });
    if (out.status !== 0) return null;
    const first = out.stdout.split(/\r?\n/).find((l) => l.trim());
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

/** Run a command to completion. Streams stdout/stderr lines to the logger. */
export function run(cmd, args, { log, tag = 'sh', env, cwd, timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    log?.info(tag, `$ ${cmd} ${args.join(' ')}`);
    const child = spawn(cmd, args, {
      env: env ?? process.env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log?.pipe(`${tag}:out`, child.stdout, 'debug');
    log?.pipe(`${tag}:err`, child.stderr, 'warn');
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} exited with ${signal ? `signal ${signal}` : `code ${code}`}`));
    });
  });
}

/** spawnSync wrapper returning trimmed stdout ('' on failure). */
export function capture(cmd, args, opts = {}) {
  try {
    const out = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
    return out.status === 0 ? out.stdout.trim() : '';
  } catch {
    return '';
  }
}

let _privEscalation = null;
/** How to drop privileges to cfg.osUser: ['runuser','-u',user,'--'] etc. */
export function privilegeWrapper(cfg) {
  if (!cfg.isRoot) return [];
  if (_privEscalation !== null) return _privEscalation;
  if (which('runuser')) _privEscalation = ['runuser', '-u', cfg.osUser, '--'];
  else if (which('su')) _privEscalation = ['su', '-s', '/bin/sh', cfg.osUser, '-c'];
  else _privEscalation = [];
  return _privEscalation;
}

/** Ensure the OS user exists (when running as root). */
export async function ensureOsUser(cfg, log) {
  if (!cfg.isRoot) return;
  const check = capture('id', ['-u', cfg.osUser]);
  if (check) {
    log.debug('user', `OS user "${cfg.osUser}" already exists`);
    return;
  }
  log.info('user', `creating OS user "${cfg.osUser}"`);
  const args = process.platform === 'win32'
    ? []
    : ['useradd', '--system', '--no-create-home', '--shell', '/usr/sbin/nologin', cfg.osUser];
  if (args.length === 0) return;
  try {
    await run('useradd', args.slice(1), { log, tag: 'useradd' });
  } catch {
    // Some minimal images lack useradd; try adduser as fallback.
    await run('adduser', ['--system', '--no-create-home', '--disabled-login', cfg.osUser], { log, tag: 'adduser' });
  }
}

/** chown -R a path to the pg OS user (no-op when not root). */
export async function chownToPgUser(cfg, target, log) {
  if (!cfg.isRoot) return;
  const bin = which('chown');
  if (!bin) return;
  try {
    await run(bin, ['-R', `${cfg.osUser}:${cfg.osUser}`, target], { log, tag: 'chown' });
  } catch (err) {
    log.warn('chown', `could not chown ${target}: ${err.message}`);
  }
}

export function fileExists(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function dirExists(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

/** Recursively list files in a directory (for binary discovery). */
export function* walk(dir, depth = 3) {
  if (depth < 0) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p, depth - 1);
    else yield p;
  }
}

/** Environment for spawned Postgres binaries (adds bundled lib dir when present). */
export function pgEnv(pg) {
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C', LC_ALL: 'C' };
  if (pg?.libDir) env.LD_LIBRARY_PATH = [pg.libDir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  return env;
}

/** True when the effective uid cannot be resolved to a passwd name. */
export function currentUserResolvable() {
  if (typeof process.getuid !== 'function' || process.getuid() === 0) return true;
  return Boolean(capture('id', ['-un']));
}

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/** Build an argv that runs a command as the configured PostgreSQL OS user when root. */
export function asPgUser(cfg, bin, args) {
  const wrap = privilegeWrapper(cfg);
  if (wrap.length !== 0) {
    if (wrap[0] === 'runuser') return [...wrap, bin, ...args];
    return [...wrap, [bin, ...args].map(shq).join(' ')];
  }
  return [bin, ...args];
}

/** Spawn a command as the configured PostgreSQL OS user when the app runs as root. */
export function spawnAsPgUser(cfg, bin, args, { env } = {}) {
  const argv = asPgUser(cfg, bin, args);
  return spawn(argv[0], argv.slice(1), {
    env: env ?? { PATH: process.env.PATH, LANG: 'C', LC_ALL: 'C' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
