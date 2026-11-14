# ShanDB implementation plan

## Goal

Run an actual PostgreSQL 17 server on Altare's Generic Node.js environment. Node.js handles first-run initialization, configuration validation, process supervision, and shutdown. PostgreSQL remains the database engine.

## Confirmed constraints

- Generic Node.js runtime
- 1.5 CPU cores, 6 GB RAM, 10 GB storage
- No Docker or systemd
- Startup commands are available; no interactive shell commands can be run after startup
- Persistent storage and public TCP port forwarding are required

## Architecture

- PostgreSQL 17 server binaries: `postgres` and `initdb`
- Node.js 22 supervisor
- Persistent `PGDATA` directory
- SCRAM-SHA-256 password authentication
- TLS required for non-loopback listeners
- PostgreSQL runs in the foreground as a child process
- No HTTP administration API in this initial implementation

## Initial resource settings

The supervisor starts PostgreSQL with 40 maximum connections, 768 MB shared buffers, 3 GB effective cache estimate, 4 MB work memory, 128 MB maintenance work memory, and a 512 MB maximum WAL size. These are conservative starting values, not a substitute for workload testing.

## Delivery checklist

- [x] Repository and deployment documentation
- [x] Node.js supervisor and first-run cluster initialization
- [x] SCRAM authentication and TLS enforcement for public listeners
- [x] Graceful process shutdown
- [x] Environment template and TypeScript configuration
- [x] CI type-check/build workflow
- [ ] Verify PostgreSQL 17 binaries exist in Altare's Generic Node.js runtime
- [ ] Confirm persistent volume path and public TCP port mapping
- [ ] Test authenticated TLS connections from Veyra
- [ ] Configure PostgreSQL-aware backups and test restoration
- [ ] Tune settings using actual resource and workload metrics

## Platform dependencies

The application does not bundle PostgreSQL. The runtime must provide `postgres` and `initdb` on `PATH`, allow Node.js to spawn them, run the app as an unprivileged user, provide durable storage, and expose a raw TCP port. If any of these capabilities are unavailable, this deployment target cannot host a real PostgreSQL server.
