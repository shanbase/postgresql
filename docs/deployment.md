# Deployment

## Runtime requirements

The host must provide Node.js 22+, PostgreSQL 17 server binaries (`postgres` and `initdb`), a writable persistent volume, and raw TCP port forwarding. The process must run as an unprivileged user.

## Build and start

```sh
npm install
npm run build
npm start
```

For a Generic Node.js startup command, use the equivalent of the commands above. PostgreSQL must be installed in the image or supplied by the platform before the Node.js process starts. This application does not run package-manager or operating-system installation commands.

## First boot

Set `PGDATA` to the persistent volume path and set `POSTGRES_PASSWORD` to a strong unique secret. First boot initializes the cluster and stores the superuser password hash in PostgreSQL. The plaintext password is written only to a temporary mode-0600 file for the duration of `initdb`, then removed.

Existing PostgreSQL 17 data directories are reused. A non-empty directory without a valid `PG_VERSION` is rejected to avoid accidental data loss.

## Public TCP deployment

Set `PG_LISTEN_ADDRESSES=*`, `POSTGRES_SSL=on`, `POSTGRES_SSL_CERT`, and `POSTGRES_SSL_KEY`. The private key file must have mode 0600 or stricter. Configure Altare to forward a public TCP port to the same port configured by `PGPORT`.

The generated `pg_hba.conf` rejects non-TLS remote connections and requires SCRAM-SHA-256 for TLS connections. Use a certificate whose trust chain is accepted by your clients.

## Local-only deployment

For local testing, use `PG_LISTEN_ADDRESSES=127.0.0.1` and `POSTGRES_SSL=off`. The supervisor refuses to disable TLS while listening on a non-loopback interface.

## Connecting

Use the host and public port assigned by Altare, the configured database user, and the `postgres` database for the initial connection. Enable SSL/TLS verification in the client. Create separate least-privilege roles and databases for each application rather than sharing the superuser.

## Operations

- Do not delete or replace `PGDATA` to reset a production instance.
- Do not copy the live data directory as a file-level backup.
- Use PostgreSQL-aware backups and regularly test restores.
- Monitor storage, WAL growth, connections, memory, and CPU.
- Rotate passwords using SQL; changing `POSTGRES_PASSWORD` after initialization does not change an existing database role password.
