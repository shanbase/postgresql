import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { createConnection } from "node:net";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { buildHba, loadSettings, type Settings } from "./config.js";

type State = "starting" | "ready" | "stopping" | "failed";
let state: State = "starting";
let postgres: ReturnType<typeof spawn> | undefined;
let healthServer: Server | undefined;

function run(command: string, args: string[], label: string): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    child.once("error", (error) => rejectPromise(new Error(`Unable to start ${label}: ${error.message}`)));
    child.once("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`${label} exited with code ${String(code)} and signal ${String(signal)}`));
    });
  });
}

async function verifyTlsFiles(settings: Settings): Promise<void> {
  if (!settings.ssl || !settings.certificate || !settings.privateKey) return;
  const certificateInfo = await stat(settings.certificate);
  const keyInfo = await stat(settings.privateKey);
  if (!certificateInfo.isFile() || !keyInfo.isFile()) {
    throw new Error("TLS certificate and private key must be regular files");
  }
  if ((keyInfo.mode & 0o077) !== 0) {
    throw new Error("TLS private key permissions must be 0600 or stricter");
  }
}

async function initializeCluster(settings: Settings): Promise<void> {
  await mkdir(dirname(settings.dataDirectory), { recursive: true });
  await mkdir(settings.dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(settings.dataDirectory, 0o700);

  const entries = await readdir(settings.dataDirectory);
  const versionFile = resolve(settings.dataDirectory, "PG_VERSION");

  try {
    const info = await lstat(versionFile);
    if (!info.isFile()) throw new Error("PGDATA/PG_VERSION is not a regular file");
    const version = (await readFile(versionFile, "utf8")).trim();
    if (version !== "17") throw new Error(`PGDATA contains PostgreSQL ${version}; this deployment requires PostgreSQL 17`);
    console.log("Existing PostgreSQL 17 data directory found");
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  if (entries.length > 0) {
    throw new Error("PGDATA is not empty and has no PG_VERSION; refusing to overwrite existing files");
  }
  if (!settings.password) throw new Error("POSTGRES_PASSWORD is required for first-time initialization");

  const temporaryDirectory = await mkdtemp(resolve(tmpdir(), "shandb-init-"));
  const passwordFile = resolve(temporaryDirectory, "password");
  try {
    await writeFile(passwordFile, `${settings.password.replace(/[\r\n]/g, "")}\n`, { mode: 0o600 });
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

function waitForPostgres(port: number, timeoutMs: number): Promise<void> {
  const started = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = (): void => {
      if (Date.now() - started >= timeoutMs) {
        rejectPromise(new Error("PostgreSQL did not become ready before the startup timeout"));
        return;
      }
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.setTimeout(700);
      socket.once("connect", () => {
        socket.destroy();
        resolvePromise();
      });
      socket.once("error", () => {
        socket.destroy();
        setTimeout(attempt, 500);
      });
      socket.once("timeout", () => {
        socket.destroy();
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

function startHealthServer(port: number): void {
  if (port === 0) return;
  healthServer = createServer((request, response) => {
    if (request.url !== "/healthz" && request.url !== "/readyz") {
      response.writeHead(404).end();
      return;
    }
    const ready = state === "ready";
    const healthy = state !== "failed";
    const ok = request.url === "/readyz" ? ready : healthy;
    response.writeHead(ok ? 200 : 503, { "content-type": "application/json", "cache-control": "no-store" });
    response.end(JSON.stringify({ status: state }));
  });
  healthServer.listen(port, "0.0.0.0", () => console.log(`Health endpoint listening on port ${port}`));
}

function postgresArguments(settings: Settings): string[] {
  const args = [
    "-D", settings.dataDirectory,
    "-c", `listen_addresses=${settings.listenAddresses}`,
    "-c", `port=${settings.port}`,
    "-c", "password_encryption=scram-sha-256",
    "-c", `max_connections=${settings.maxConnections}`,
    "-c", `shared_buffers=${settings.sharedBuffers}`,
    "-c", `effective_cache_size=${settings.effectiveCacheSize}`,
    "-c", `work_mem=${settings.workMem}`,
    "-c", `maintenance_work_mem=${settings.maintenanceWorkMem}`,
    "-c", `max_wal_size=${settings.maxWalSize}`,
    "-c", "min_wal_size=80MB",
    "-c", "checkpoint_completion_target=0.9",
    "-c", "log_destination=stderr",
    "-c", "logging_collector=off"
  ];
  if (settings.ssl && settings.certificate && settings.privateKey) {
    args.push("-c", "ssl=on", "-c", `ssl_cert_file=${settings.certificate}`, "-c", `ssl_key_file=${settings.privateKey}`);
  } else {
    args.push("-c", "ssl=off");
  }
  return args;
}

async function startPostgres(settings: Settings): Promise<void> {
  postgres = spawn("postgres", postgresArguments(settings), { stdio: "inherit", env: process.env });
  let shuttingDown = false;

  const shutdown = (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    state = "stopping";
    console.log(`Forwarding ${signal} to PostgreSQL`);
    postgres?.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
    setTimeout(() => {
      if (postgres && postgres.exitCode === null) postgres.kill("SIGKILL");
    }, 10000).unref();
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));

  await new Promise<void>((resolvePromise, rejectPromise) => {
    postgres?.once("error", (error) => rejectPromise(new Error(`Unable to start PostgreSQL: ${error.message}`)));
    postgres?.once("exit", (code, signal) => {
      if (code === 0 || shuttingDown) resolvePromise();
      else rejectPromise(new Error(`PostgreSQL exited unexpectedly with code ${String(code)} and signal ${String(signal)}`));
    });
  });
}

async function main(): Promise<void> {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    throw new Error("PostgreSQL must run as an unprivileged user, not root");
  }
  const settings = loadSettings();
  startHealthServer(settings.healthPort);
  await verifyTlsFiles(settings);
  await initializeCluster(settings);
  console.log(`Starting PostgreSQL 17 on port ${settings.port}`);
  postgres = spawn("postgres", postgresArguments(settings), { stdio: "inherit", env: process.env });
  postgres.once("error", (error) => {
    state = "failed";
    console.error(`Unable to start PostgreSQL: ${error.message}`);
  });
  await waitForPostgres(settings.port, 30000);
  state = "ready";
  console.log("PostgreSQL TCP listener is accepting connections");
  await new Promise<void>((resolvePromise, rejectPromise) => {
    postgres?.once("exit", (code, signal) => {
      state = code === 0 ? "stopping" : "failed";
      if (code === 0) resolvePromise();
      else rejectPromise(new Error(`PostgreSQL exited with code ${String(code)} and signal ${String(signal)}`));
    });
    const shutdown = (signal: NodeJS.Signals): void => {
      if (!postgres || postgres.exitCode !== null) return;
      state = "stopping";
      console.log(`Forwarding ${signal} to PostgreSQL`);
      postgres.kill(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
      setTimeout(() => {
        if (postgres && postgres.exitCode === null) postgres.kill("SIGKILL");
      }, 10000).unref();
    };
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  });
  await new Promise<void>((resolvePromise) => healthServer?.close(() => resolvePromise()) ?? resolvePromise());
}

main().catch(async (error: unknown) => {
  state = "failed";
  console.error(`ShanDB startup failed: ${error instanceof Error ? error.message : String(error)}`);
  await new Promise<void>((resolvePromise) => healthServer?.close(() => resolvePromise()) ?? resolvePromise());
  process.exitCode = 1;
});
