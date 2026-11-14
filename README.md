# ShanDB

ShanDB runs an actual PostgreSQL 17 server with a small Node.js 22 supervisor. Node.js is not a database engine; it initializes and supervises PostgreSQL, validates configuration, and exposes an optional health endpoint.

## Features

- Safe first-run PostgreSQL cluster initialization
- Existing cluster version checks and protection against overwriting non-empty data directories
- SCRAM-SHA-256 password authentication
- TLS required for non-loopback listeners
- Conservative resource defaults for a small 1.5-core instance
- Startup readiness probe and optional HTTP health endpoints
- Graceful shutdown with forced termination fallback
- TypeScript configuration tests and GitHub Actions CI

## Requirements

- Linux with PostgreSQL 17 server binaries (`postgres` and `initdb`) on `PATH`
- Node.js 22+
- Unprivileged runtime user
- Persistent writable volume for `PGDATA`
- Raw TCP port forwarding for PostgreSQL
- TLS certificate and private key files for public listeners

## Build and run

```sh
npm install
npm run build
npm start
```

Set environment variables using [.env.example](.env.example). On first boot, set a strong `POSTGRES_PASSWORD`. The password is passed to `initdb` through a temporary mode-0600 file and is not committed to the repository.

## Public deployment

Set `PG_LISTEN_ADDRESSES=*`, `POSTGRES_SSL=on`, `POSTGRES_SSL_CERT`, and `POSTGRES_SSL_KEY`. Ensure the private key has mode 0600 or stricter. Forward the public TCP port assigned by the host to `PGPORT`.

The generated host-based authentication rules reject non-TLS remote sessions and require SCRAM-SHA-256 for TLS sessions.

## Health endpoints

Set `HEALTH_PORT` to a host-accessible HTTP port. The supervisor exposes:

- `GET /healthz` — process health
- `GET /readyz` — PostgreSQL TCP listener readiness

The health server is disabled when `HEALTH_PORT=0`.

## Resource defaults

The defaults are designed as a conservative starting point for 1.5 CPU cores and 6 GB RAM: 30 connections, 768 MB shared buffers, 3 GB effective cache estimate, 4 MB work memory, 128 MB maintenance work memory, and 512 MB maximum WAL size. These values must be tuned against real workload and disk constraints.

## Critical platform limitations

This application does not bundle PostgreSQL or install operating-system packages. The Generic Node.js runtime must provide the PostgreSQL 17 binaries and allow Node.js to spawn native child processes. The host must provide durable storage and raw TCP port mapping. If those conditions are not met, this platform cannot run a real PostgreSQL server.

Use PostgreSQL-aware backups and test restores before storing important application data. Do not copy a live data directory as an ordinary file backup.
