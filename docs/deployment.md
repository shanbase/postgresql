# Deployment

## Required platform capabilities

The runtime must provide Node.js 22+, PostgreSQL 17 server binaries (`postgres`, `initdb`), native child-process execution, an unprivileged process identity, persistent writable storage, and raw TCP port forwarding.

## Build and startup

```sh
npm install
npm run build
npm start
```

Use the equivalent command in the Generic Node.js startup configuration. This project deliberately does not run OS package installation commands at runtime.

## First boot

Set `PGDATA` to the persistent volume path and set `POSTGRES_PASSWORD` to a strong unique secret. The first boot initializes a PostgreSQL 17 cluster. Existing clusters are reused only when their `PG_VERSION` is 17. A non-empty directory without a valid version marker is rejected.

## Public TLS listener

Configure `PG_LISTEN_ADDRESSES=*`, `POSTGRES_SSL=on`, `POSTGRES_SSL_CERT`, and `POSTGRES_SSL_KEY`. The private key must have permissions 0600 or stricter. Configure Altare to forward its public TCP port to `PGPORT`.

## Health checks

Set `HEALTH_PORT` to an HTTP port if the platform supports a second port. Probe `/healthz` for process health and `/readyz` for PostgreSQL listener readiness. Leave it at zero if a second HTTP port is unavailable.

## Security and operations

- Keep the superuser credentials private.
- Create separate least-privilege roles and databases for each application after deployment.
- Require certificate verification in application clients.
- Use PostgreSQL-aware backups and test restores.
- Monitor storage and WAL growth closely on a 10 GB volume.
- Changing `POSTGRES_PASSWORD` after initialization does not rotate an existing PostgreSQL role password; use SQL role management.
- Do not delete or replace the data directory to reset production data.
