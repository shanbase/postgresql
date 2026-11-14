import { spawn } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";

type Settings = {
  dataDirectory: string;
  port: number;
  listenAddresses: string;
  username: string;
  password: string | undefined;
  ssl: boolean;
  certificate: string | undefined;
  privateKey: string | undefined;
};

function loadSettings(): Settings {
  const port = Number(process.env.PGPORT ?? "5432");
  const username = process.env.POSTGRES_USER ?? "postgres";
  const sslValue = (process.env.POSTGRES_SSL ?? "on").toLowerCase();
  const settings: Settings = {
    dataDirectory: resolve(process.env.PGDATA ?? "./data/postgres"),
    port,
    listenAddresses: process.env.PG_LISTEN_ADDRESSES ?? "127.0.0.1",
    username,
    password: process.env.POSTGRES_PASSWORD,
    ssl: sslValue === "on",
    certificate: process.env.POSTGRES_SSL_CERT ? resolve(process.env.POSTGRES_SSL_CERT) : undefined,
    privateKey: process.env.POSTGRES_SSL_KEY ? resolve(process.env.POSTGRES_SSL_KEY) : undefined
  };

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PGPORT must be an integer between 1 and 65535");
  }

  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(username)) {
    throw new Error("POSTGRES_USER must be a valid simple PostgreSQL role name");
  }

  if (sslValue !== "on" && sslValue !== "off") {
    throw new Error("POSTGRES_SSL must be either on or off");
  }

  const loopbackOnly = settings.listenAddresses.split(",").every((address) => {
    const value = address.trim().toLowerCase();
    return value === "localhost" || value === "127.0.0.1" || value === "::1";
  });

  if (!settings.ssl && !loopbackOnly) {
    throw new Error("TLS is required when PostgreSQL listens on a non-loopback interface");
  }

  if (settings.ssl && (!settings.certificate || !settings.privateKey)) {
    throw new Error("POSTGRES_SSL_CERT and POSTGRES_SSL_KEY are required when POSTGRES_SSL=on");
  }

  return settings;
}

function run(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", (error) => rejectPromise(new Error(`Unable to start ${label}: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`${label} exited with code ${String(code)} and signal ${String(signal)}`));
      }
    });
  });
}

async function verifyTlsFiles(settings: Settings): Promise<void> {
  if (!settings.ssl || !settings.certificate || !settings.privateKey) {
    return;
  }

  await stat(settings.certificate);
  const keyInfo = await stat(settings.privateKey);

  if ((keyInfo.mode & 0o077) !== 0) {
    throw new Error("TLS private key permissions must be 0600 or stricter");
  }
}

function buildHba(ssl: boolean): string {
  const lines = ["local all all scram-sha-256"];

  if (ssl) {
    lines.push(
      "hostnossl all all 0.0.0.0/0 reject",
      "hostnossl all all ::/0 reject",
      "hostssl all all 0.0.0.0/0 scram-sha-256",
      "hostssl all all ::/0 scram-sha-256"
    );
  } else {
    lines.push(
      "host all all 127.0.0.1/32 scram-sha-256",
      "host all all ::1/128 scram-sha-256"
    );
  }

  return `${lines.join("\n")}\n`;
}

async function initializeCluster(settings: Settings): Promise<void> {
  await mkdir(dirname(settings.dataDirectory), { recursive: true });
  await mkdir(settings.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(settings.dataDirectory, 0o700);

  const entries = await readdir(settings.dataDirectory);
  const versionFile = resolve(settings.dataDirectory, "PG_VERSION");

  try {
    const info = await lstat(versionFile);
    if (!info.isFile()) {
      throw new Error("PGDATA/PG_VERSION is not a regular file");
    }

    const version = (await readFile(versionFile, "utf8")).trim();
    if (version !== "17") {
      throw new Error(`PGDATA contains PostgreSQL ${version}; this deployment requires PostgreSQL 17`);
    }

    console.log("Existing PostgreSQL 17 data directory found");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }

  if (entries.length > 0) {
    throw new Error("PGDATA is not empty and has no PG_VERSION; refusing to overwrite existing files");
  }

  if (!settings.password) {
    throw new Error("POSTGRES_PASSWORD is required for first-time initialization");
  }

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "shandb-init-"));
  const passwordFile = resolve(temporaryDirectory, "password");

  try {
    await writeFile(passwordFile, `${settings.password.replace(/\n/g, "")}\n`, { mode: 0o600 });
    await chmod(passwordFile, 0o600);
    await run("initdb", [
      "--pgdata", settings.dataDirectory,
      "--username", settings.username,
      "--pwfile", passwordFile,
      "--auth-local=scram-sha-256",
      "--auth-host=scram-sha-256",
      "--encoding=UTF8",
      "--data-checksums"
    ], "initdb");

    await writeFile(resolve(settings.dataDirectory, "pg_hba.conf"), buildHba(settings.ssl), { mode: 0o600 });
    console.log("PostgreSQL 17 cluster initialized");
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

async function startPostgres(settings: Settings): Promise<void> {
  const args = [
    "-D", settings.dataDirectory,
    "-c", `listen_addresses=${settings.listenAddresses}`,
    "-c", `port=${settings.port}`,
    "-c", "password_encryption=scram-sha-256",
    "-c", "max_connections=40",
    "-c", "shared_buffers=768MB",
    "-c", "effective_cache_size=3GB",
    "-c", "work_mem=4MB",
    "-c", "maintenance_work_mem=128MB",
    "-c", "max_wal_size=512MB",
    "-c", "min_wal_size=80MB",
    "-c", "checkpoint_completion_target=0.9",
    "-c", "log_destination=stderr",
    "-c", "logging_collector=off"
  ];

  if (settings.ssl && settings.certificate && settings.privateKey) {
    args.push(
      "-c", "ssl=on",
      "-c", `ssl_cert_file=${settings.certificate}`,
      "-c", `ssl_key_file=${settings.privateKey}`
    );
  } else {
    args.push("-c", "ssl=off");
  }

  const child = spawn("postgres", args, { stdio: "inherit", env: process.env });
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    console.log(`Forwarding ${signal} to PostgreSQL`);
    child.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise<void>((resolvePromise, rejectPromise) => {
    child.once("error", (error) => rejectPromise(new Error(`Unable to start PostgreSQL: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0 || shuttingDown) {
        resolvePromise();
      } else {
        rejectPromise(new Error(`PostgreSQL exited unexpectedly with code ${String(code)} and signal ${String(signal)}`));
      }
    });
  });
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("PostgreSQL must run as an unprivileged user, not root");
  }

  const settings = loadSettings();
  await verifyTlsFiles(settings);
  await initializeCluster(settings);
  console.log(`Starting PostgreSQL 17 on port ${settings.port}`);
  await startPostgres(settings);
}

main().catch((error: unknown) => {
  console.error(`ShanDB startup failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
