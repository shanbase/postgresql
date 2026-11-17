import fs from 'node:fs';
let s = fs.readFileSync('lib/setup.mjs', 'utf8');

const anchor = "    log.info('initdb', `initializing data directory at ${cfg.dataDir}`);";
const replica = `    if (cfg.replica) {
      const r = cfg.replica;
      if (!r.password) {
        throw new Error('PG_REPLICA_PASSWORD is required when PG_REPLICA_HOST is set (replica mode).');
      }
      const basebackup = bin(cfg, pg, 'pg_basebackup');
      if (!fileExists(basebackup)) {
        throw new Error(
          \`pg_basebackup not found in \${pg.binDir}. Install PostgreSQL client tools \` +
          'matching the primary major version (e.g. postgresql-client-18) or set PG_BIN.',
        );
      }
      log.info('replica', \`bootstrapping streaming replica from \${r.user}@\${r.host}:\${r.port}/\${r.database} (slot \${r.slot})\`);
      const env = { ...process.env, PGPASSWORD: r.password };
      const args = asPgUser(cfg, basebackup, [
        '-h', r.host, '-p', String(r.port), '-U', r.user, '-d', r.database,
        '-D', cfg.dataDir, '-X', 'stream', '-S', r.slot,
      ]);
      await run(args[0], args.slice(1), { log, tag: 'basebackup', env, timeoutMs: 60 * 60 * 1000 });

      fs.writeFileSync(path.join(cfg.dataDir, 'standby.signal'), '');
      const autoConf = path.join(cfg.dataDir, 'postgresql.auto.conf');
      fs.appendFileSync(autoConf,
        \`primary_conninfo = 'user=\${r.user} password=\${r.password} host=\${r.host} port=\${r.port}'\\n\` +
        \`primary_slot_name = '\${r.slot}'\\n\`);
      log.info('replica', 'standby.signal + primary_conninfo written — this node will run as a read-only standby');
    } else {
`;

if (!s.includes(anchor)) { console.log('ANCHOR NOT FOUND'); process.exit(1); }
s = s.replace(anchor, replica + anchor);

const tail = "      fs.rmSync(bootstrapDir, { recursive: true, force: true });\n    }\n  } else {";
if (!s.includes(tail)) { console.log('TAIL NOT FOUND'); process.exit(1); }
s = s.replace(tail, "      fs.rmSync(bootstrapDir, { recursive: true, force: true });\n    }\n    }\n  } else {");

fs.writeFileSync('lib/setup.mjs', s);
console.log('patched setup.mjs');

// index.mjs: skip ensureDatabases in replica mode
let idx = fs.readFileSync('index.mjs', 'utf8');
const call = 'await supervisor.ensureDatabases(password, log);';
if (!idx.includes(call)) { console.log('INDEX ANCHOR NOT FOUND'); process.exit(1); }
idx = idx.replace(call, "if (!cfg.replica) await supervisor.ensureDatabases(password, log);\n    else log.info('boot', 'replica mode — skipping database bootstrap (read-only standby)');");
fs.writeFileSync('index.mjs', idx);
console.log('patched index.mjs');

// .env.example: document replica vars
let env = fs.readFileSync('.env.example', 'utf8');
env += `
# ── Replica mode (optional) ──────────────────────────────────────────────
# Set PG_REPLICA_HOST to run this node as a read-only streaming replica of a
# remote primary instead of bootstrapping a fresh database. The data dir is
# seeded with pg_basebackup and database/role creation is skipped.
# PG_REPLICA_HOST=mn-uln01.altare.global
# PG_REPLICA_PORT=25204
# PG_REPLICA_USER=veyra_replicator
# PG_REPLICA_PASSWORD=
# PG_REPLICA_SLOT=veyra_eu_slot
# PG_REPLICA_DB=postgres
`;
fs.writeFileSync('.env.example', env);
console.log('patched .env.example');

// package.json: bump version
let pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
pkg.version = '1.0.3';
fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
console.log('done');
