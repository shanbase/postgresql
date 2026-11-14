# ShanDB

A self-hosted PostgreSQL 17 instance managed by a small Node.js 22 supervisor. PostgreSQL is the database engine; Node.js handles first-run initialization, configuration validation, process lifecycle, and shutdown.

## Status

Initial implementation. It expects the PostgreSQL 17 server binaries (`postgres` and `initdb`) to be installed in the runtime environment. The application does not bundle or emulate PostgreSQL.

## Requirements

- Linux environment with PostgreSQL 17 server binaries available on `PATH`
- Node.js 22 or newer
- Persistent writable storage for `PGDATA`
- A TLS certificate and private key when listening on a public interface

## Run

Install dependencies and build:

```sh
npm install
npm run build
```

Configure the environment using `.env.example` as a reference, then start:

```sh
npm start
```

The first start requires `POSTGRES_PASSWORD`. It is used to initialize the database superuser and is not stored in the repository. Existing data directories are never reinitialized.

For a public listener, set `PG_LISTEN_ADDRESSES=*`, provide `POSTGRES_SSL_CERT` and `POSTGRES_SSL_KEY`, and expose the configured `PGPORT` through the hosting provider. Non-TLS remote connections are rejected by the generated host-based authentication rules.

## Important deployment notes

- Set `PGDATA` to Altare's persistent storage location. The default `./data/postgres` is only suitable if the application directory is persistent.
- The hosting provider must permit the Node.js process to spawn native PostgreSQL executables.
- The provider must route an external TCP port to `PGPORT`; a web-only HTTP port is not sufficient.
- PostgreSQL must run as an unprivileged application user. Do not run it as root.
- Back up the data directory using PostgreSQL-aware backup procedures. Do not copy a live data directory as an ordinary file backup.
- This project does not expose an HTTP administration API.

## Environment

See [.env.example](.env.example) for supported settings and safe defaults.

## License

PostgreSQL is distributed under its own license. This supervisor is licensed under the MIT License.
