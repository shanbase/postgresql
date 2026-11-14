# ShanDB implementation plan

## Goal

Host a real PostgreSQL 17 database server on Altare's Generic Node.js environment, using Node.js only for startup, configuration validation, process supervision, readiness, and health reporting.

## Resource allocation

- CPU: 1.5 cores
- RAM: 6 GB
- Storage: 10 GB

## Implemented

- [x] PostgreSQL 17 first-run cluster initialization
- [x] Refuse to overwrite non-empty uninitialized data directories
- [x] Verify existing cluster major version
- [x] SCRAM-SHA-256 authentication
- [x] TLS required for non-loopback listeners
- [x] Validate TLS file existence and private-key permissions
- [x] Configurable connection and memory settings
- [x] TCP readiness probe
- [x] Optional HTTP health and readiness endpoints
- [x] Graceful shutdown with forced termination fallback
- [x] Automated configuration and HBA tests
- [x] CI type-check and test workflow
- [x] Deployment and security documentation

## External deployment requirements

- [ ] Confirm Altare Generic Node.js provides PostgreSQL 17 binaries
- [ ] Confirm native child-process execution is permitted
- [ ] Confirm persistent volume path and ownership
- [ ] Confirm raw TCP port forwarding and TLS certificate file provisioning
- [ ] Deploy and validate remote TLS connections from Veyra
- [ ] Configure PostgreSQL-aware off-instance backups and test restoration
- [ ] Establish monitoring and disk-space alerting

## Operational boundary

No application code can compensate for a hosting runtime that lacks PostgreSQL server binaries, persistent storage, or raw TCP networking. Those platform capabilities must be verified before this can be called deployed or production-ready.
