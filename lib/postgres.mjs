// PostgreSQL process supervisor: spawns `postgres -D <dataDir>` in the
// foreground, streams its output into the logger, restarts it with backoff
// on unexpected exits, and shuts it down cleanly on SIGINT/SIGTERM.
// Readiness is a TCP connect check and database creation goes through the
// `pg` driver, because user-space Postgres bundles (embedded-postgres) ship
// only initdb/pg_ctl/postgres — no psql/createdb/pg_isready.
import path from 'node:path';
import net from 'node:net';
import { spawnAsPgUser, pgEnv } from './procs.mjs';

function tcpReady(port, host = '127.0.0.1', timeoutMs = 2000) {
  return new Promise((resolve) => {
    const sock = net.connect({ port, host });
    const done = (ok) => { sock.destroy(); resolve(ok); };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

export class PostgresSupervisor {
  constructor(cfg, pg, log) {
    this.cfg = cfg;
    this.pg = pg;
    this.log = log;
    this.child = null;
    this.stopped = false;
    this.restartTimer = null;
    this.backoffMs = 1000;
    this.restarts = 0;
    this.startedAt = null;
  }

  bin(name) {
    return path.join(this.pg.binDir, process.platform === 'win32' ? `${name}.exe` : name);
  }

  launch() {
    const cfg = this.cfg;
    const postgresBin = this.bin('postgres');
    this.log.info('postgres', `starting ${postgresBin} -D ${cfg.dataDir} (port ${cfg.port})`);
    const child = spawnAsPgUser(cfg, postgresBin, ['-D', cfg.dataDir], { env: pgEnv(this.pg) });
    this.child = child;
    this.startedAt = Date.now();

    this.log.pipe('postgres', child.stdout, 'info');
    this.log.pipe('postgres', child.stderr, 'warn');

    child.on('error', (err) => {
      this.log.error('postgres', `failed to spawn: ${err.message}`);
      this.scheduleRestart();
    });

    child.on('exit', (code, signal) => {
      this.child = null;
      const uptime = this.startedAt ? ((Date.now() - this.startedAt) / 1000).toFixed(1) : '?';
      if (this.stopped) {
        this.log.info('postgres', `stopped (code=${code} signal=${signal}, uptime=${uptime}s)`);
        return;
      }
      this.log.error('postgres', `exited unexpectedly (code=${code} signal=${signal}, uptime=${uptime}s) — restarting in ${this.backoffMs}ms`);
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.stopped || this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, 30000);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.restarts += 1;
      this.log.info('postgres', `restart attempt #${this.restarts}`);
      this.launch();
    }, delay);
    this.restartTimer.unref?.();
  }

  /** Wait until the port accepts TCP connections (or timeout). */
  async waitReady(timeoutMs = 90000) {
    const deadline = Date.now() + timeoutMs;
    let attempt = 0;
    while (Date.now() < deadline) {
      attempt += 1;
      if (await tcpReady(this.cfg.port)) {
        this.log.info('postgres', `accepting connections on port ${this.cfg.port} (after ${attempt} check(s))`);
        return true;
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    this.log.error('postgres', `not ready after ${timeoutMs}ms`);
    return false;
  }

  /** Create configured databases via the pg driver (needs superuser password). */
  async ensureDatabases(password, log) {
    let pgClient;
    try {
      ({ Client: pgClient } = await import('pg'));
    } catch (err) {
      log.warn('database', `pg driver unavailable, cannot create databases: ${err.message}`);
      return;
    }

    const client = new pgClient({
      host: '127.0.0.1',
      port: this.cfg.port,
      user: this.cfg.superuser,
      password,
      database: 'postgres',
      ssl: this.cfg.ssl === 'on' ? { rejectUnauthorized: false } : false,
      connectionTimeoutMillis: 10000,
    });

    try {
      // TCP-ready can precede full postmaster readiness — retry briefly.
      let lastErr;
      for (let i = 0; i < 10; i += 1) {
        try { await client.connect(); lastErr = null; break; }
        catch (err) { lastErr = err; await new Promise((r) => setTimeout(r, 1500)); }
      }
      if (lastErr) throw lastErr;
      log.info('database', `connected as ${this.cfg.superuser} to create databases`);
      for (const db of this.cfg.databases) {
        if (db === 'postgres') continue; // created by initdb
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(db)) {
          log.warn('database', `skipping unsafe database name "${db}"`);
          continue;
        }
        try {
          await client.query(`CREATE DATABASE "${db}"`);
          log.info('database', `created database "${db}"`);
        } catch (err) {
          if (err.code === '42P04') {
            log.info('database', `database "${db}" already exists`);
          } else {
            log.warn('database', `could not create "${db}": ${err.message}`);
          }
        }
      }
    } catch (err) {
      log.warn('database', `admin connection failed: ${err.message}`);
    } finally {
      await client.end().catch(() => {});
    }
  }

  async stop() {
    this.stopped = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    const child = this.child;
    if (!child) return;
    this.log.info('postgres', 'shutting down (SIGINT → fast shutdown)');
    child.kill('SIGINT');
    const exited = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 15000);
      child.once('exit', () => { clearTimeout(t); resolve(true); });
    });
    if (!exited) {
      this.log.warn('postgres', 'did not exit in 15s — sending SIGKILL');
      child.kill('SIGKILL');
    }
  }
}
