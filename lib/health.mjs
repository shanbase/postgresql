// Optional HTTP health/status endpoint (HEALTH_PORT). Disabled when 0.
import http from 'node:http';

export function startHealthServer(cfg, pg, supervisor, log) {
  if (!cfg.healthPort) return null;

  const server = http.createServer((req, res) => {
    const json = (code, body) => {
      res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    if (req.url === '/healthz' || req.url === '/') {
      const up = Date.now() - (supervisor.startedAt || Date.now());
      json(200, {
        status: 'ok',
        postgres: 'running',
        port: cfg.port,
        ssl: cfg.ssl,
        uptimeSeconds: Math.floor(up / 1000),
        restarts: supervisor.restarts,
        version: pg.version,
      });
      return;
    }
    json(404, { error: 'not found' });
  });

  server.listen(cfg.healthPort, '0.0.0.0', () => {
    log.info('health', `status endpoint listening on http://0.0.0.0:${cfg.healthPort}/healthz`);
  });
  server.on('error', (err) => log.error('health', `health server error: ${err.message}`));
  return server;
}
