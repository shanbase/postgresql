import { resolve } from "node:path";

export type Environment = Record<string, string | undefined>;

export type Settings = {
  dataDirectory: string;
  port: number;
  listenAddresses: string;
  username: string;
  password: string | undefined;
  ssl: boolean;
  certificate: string | undefined;
  privateKey: string | undefined;
  maxConnections: number;
  sharedBuffers: string;
  effectiveCacheSize: string;
  workMem: string;
  maintenanceWorkMem: string;
  maxWalSize: string;
  healthPort: number;
};

function parsePort(value: string | undefined, name: string, fallback: number): number {
  const port = Number(value ?? fallback);
  if (!Number.isInteger(port) || port < 0 || port > 65535 || (name !== "HEALTH_PORT" && port === 0)) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return port;
}

function parseInteger(value: string | undefined, name: string, fallback: number, minimum: number, maximum: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  }
  return parsed;
}

export function buildHba(ssl: boolean): string {
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

export function loadSettings(env: Environment = process.env): Settings {
  const port = parsePort(env.PGPORT, "PGPORT", 5432);
  const healthPort = parsePort(env.HEALTH_PORT, "HEALTH_PORT", 0);
  const username = env.POSTGRES_USER ?? "postgres";
  const sslValue = (env.POSTGRES_SSL ?? "off").toLowerCase();
  const listenAddresses = env.PG_LISTEN_ADDRESSES ?? "127.0.0.1";
  const loopbackOnly = listenAddresses.split(",").every((address) => {
    const value = address.trim().toLowerCase();
    return value === "localhost" || value === "127.0.0.1" || value === "::1";
  });

  if (!/^[a-zA-Z_][a-zA-Z0-9_-]{0,62}$/.test(username)) {
    throw new Error("POSTGRES_USER must be a valid simple PostgreSQL role name");
  }
  if (sslValue !== "on" && sslValue !== "off") {
    throw new Error("POSTGRES_SSL must be either on or off");
  }

  const ssl = sslValue === "on";
  const certificate = env.POSTGRES_SSL_CERT ? resolve(env.POSTGRES_SSL_CERT) : undefined;
  const privateKey = env.POSTGRES_SSL_KEY ? resolve(env.POSTGRES_SSL_KEY) : undefined;

  if (!ssl && !loopbackOnly) {
    throw new Error("TLS is required when PostgreSQL listens on a non-loopback interface");
  }
  if (ssl && (!certificate || !privateKey)) {
    throw new Error("POSTGRES_SSL_CERT and POSTGRES_SSL_KEY are required when POSTGRES_SSL=on");
  }

  return {
    dataDirectory: resolve(env.PGDATA ?? "./data/postgres"),
    port,
    listenAddresses,
    username,
    password: env.POSTGRES_PASSWORD,
    ssl,
    certificate,
    privateKey,
    maxConnections: parseInteger(env.PG_MAX_CONNECTIONS, "PG_MAX_CONNECTIONS", 30, 10, 100),
    sharedBuffers: env.PG_SHARED_BUFFERS ?? "768MB",
    effectiveCacheSize: env.PG_EFFECTIVE_CACHE_SIZE ?? "3GB",
    workMem: env.PG_WORK_MEM ?? "4MB",
    maintenanceWorkMem: env.PG_MAINTENANCE_WORK_MEM ?? "128MB",
    maxWalSize: env.PG_MAX_WAL_SIZE ?? "512MB",
    healthPort
  };
}
