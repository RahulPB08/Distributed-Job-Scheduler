import http from 'http';
import { workerPool } from './worker_pool.js';
import { CheckpointLogger } from './checkpoint_logger.js';

export class WorkerApiServer {
  constructor(port = 5001) {
    this.port = parseInt(process.env.WORKER_API_PORT || port, 10);
    this.server = null;
  }

  start() {
    this.server = http.createServer(async (req, res) => {
      // Set JSON headers
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
      }

      const url = new URL(req.url, `http://localhost:${this.port}`);
      const pathname = url.pathname;

      // Parse JSON body helper
      const parseBody = () =>
        new Promise((resolve) => {
          let body = '';
          req.on('data', (chunk) => (body += chunk));
          req.on('end', () => {
            try {
              resolve(body ? JSON.parse(body) : {});
            } catch (e) {
              resolve({});
            }
          });
        });

      try {
        // ── GET /health ──
        if (req.method === 'GET' && pathname === '/health') {
          res.writeHead(200);
          return res.end(
            JSON.stringify({
              status: 'healthy',
              service: 'worker-deployment-service',
              fleetSize: workerPool.workers.size,
              timestamp: new Date().toISOString()
            })
          );
        }

        // ── GET /workers ──
        if (req.method === 'GET' && pathname === '/workers') {
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, data: workerPool.getFleetStatus() }));
        }

        // ── POST /workers/deploy ──
        if (req.method === 'POST' && pathname === '/workers/deploy') {
          const body = await parseBody();
          const deployed = await workerPool.deployWorker(body);
          res.writeHead(201);
          return res.end(JSON.stringify({ success: true, data: deployed }));
        }

        // ── POST /workers/drain ──
        if (req.method === 'POST' && pathname === '/workers/drain') {
          const body = await parseBody();
          const result = await workerPool.drainWorker(body.workerId, true);
          res.writeHead(result.success ? 200 : 400);
          return res.end(JSON.stringify(result));
        }

        // ── POST /workers/hibernate ──
        if (req.method === 'POST' && pathname === '/workers/hibernate') {
          const body = await parseBody();
          const result = await workerPool.drainWorker(body.workerId, false);
          res.writeHead(result.success ? 200 : 400);
          return res.end(JSON.stringify(result));
        }

        // ── POST /workers/shutdown ──
        if (req.method === 'POST' && pathname === '/workers/shutdown') {
          const body = await parseBody();
          const result = await workerPool.drainWorker(body.workerId, true);
          res.writeHead(result.success ? 200 : 400);
          return res.end(JSON.stringify(result));
        }

        // ── POST /workers/scale ──
        if (req.method === 'POST' && pathname === '/workers/scale') {
          const body = await parseBody();
          const result = await workerPool.scaleTo(body.targetWorkers || body.targetCount);
          res.writeHead(200);
          return res.end(JSON.stringify({ success: true, data: result }));
        }

        // 404
        res.writeHead(404);
        res.end(JSON.stringify({ success: false, error: 'Endpoint not found' }));
      } catch (err) {
        CheckpointLogger.error(`Worker API Error: ${err.message}`, err);
        res.writeHead(500);
        res.end(JSON.stringify({ success: false, error: err.message }));
      }
    });

    this.server.listen(this.port, '0.0.0.0', () => {
      CheckpointLogger.info(
        `[WORKER_DEPLOYMENT_API] ⚡ Worker Deployment Server listening on http://0.0.0.0:${this.port}`
      );
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
  }
}
