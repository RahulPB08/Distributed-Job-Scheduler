import { z } from 'zod';
import { run, get, all } from '../database/db.js';

export const provisionSchema = z.object({
  name: z.string().min(1),
  hostname: z.string().min(1).default('worker-node'),
  ipAddress: z.string().min(1).default('127.0.0.1'),
  concurrencyLimit: z.number().int().min(1).max(50).default(5)
});

export class WorkerController {
  static async list(req, res, next) {
    try {
      const workers = await all('SELECT * FROM workers ORDER BY started_at DESC');
      const now = Date.now();
      const enriched = workers.map((w) => {
        const lastHb = new Date(w.last_heartbeat_at).getTime();
        const diffSeconds = Math.max(0, Math.floor((now - lastHb) / 1000));
        let computedStatus = w.status;
        if (w.status !== 'stopped' && w.status !== 'draining') {
          if (diffSeconds > 45) {
            computedStatus = 'dead';
          } else if (diffSeconds > 15) {
            computedStatus = 'degraded';
          } else {
            computedStatus = 'healthy';
          }
        }
        return {
          ...w,
          status: computedStatus,
          seconds_since_heartbeat: diffSeconds
        };
      });

      res.json({ success: true, data: enriched });
    } catch (err) {
      next(err);
    }
  }

  static async provision(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required to provision workers' } });
      }

      const parsed = provisionSchema.parse(req.body);
      const id = `worker-${parsed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${Date.now().toString().slice(-4)}`;
      const now = new Date().toISOString();

      await run(
        'INSERT INTO workers (id, hostname, ip_address, concurrency_limit, active_jobs_count, status, total_jobs_processed, failed_jobs_count, started_at, last_heartbeat_at) VALUES (?, ?, ?, ?, 0, "healthy", 0, 0, ?, ?)',
        [id, parsed.hostname, parsed.ipAddress, parsed.concurrencyLimit, now, now]
      );

      const created = await get('SELECT * FROM workers WHERE id = ?', [id]);
      res.status(201).json({ success: true, data: created });
    } catch (err) {
      next(err);
    }
  }

  static async drain(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required to drain workers' } });
      }
      const { id } = req.params;
      await run('UPDATE workers SET status = "draining" WHERE id = ?', [id]);

      const workerApiUrl = process.env.WORKER_API_URL || 'http://worker:5001';
      try {
        await fetch(`${workerApiUrl}/workers/drain`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workerId: id })
        });
      } catch (_) {}

      res.json({ success: true, message: `Worker ${id} set to draining` });
    } catch (err) {
      next(err);
    }
  }

  static async stop(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required to stop workers' } });
      }
      const { id } = req.params;
      await run('UPDATE workers SET status = "stopped", active_jobs_count = 0 WHERE id = ?', [id]);
      await run('DELETE FROM workers WHERE id = ?', [id]);
      await run('DELETE FROM worker_heartbeats WHERE worker_id = ?', [id]);

      const workerApiUrl = process.env.WORKER_API_URL || 'http://worker:5001';
      try {
        await fetch(`${workerApiUrl}/workers/shutdown`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ workerId: id })
        });
      } catch (_) {
        try {
          await fetch('http://127.0.0.1:5001/workers/shutdown', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ workerId: id })
          });
        } catch (_) {}
      }

      res.json({ success: true, message: `Worker ${id} stopped and decommissioned` });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const { id } = req.params;
      const worker = await get('SELECT * FROM workers WHERE id = ?', [id]);
      if (!worker) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Worker not found' } });
      }

      const recentHeartbeats = await all(
        'SELECT * FROM worker_heartbeats WHERE worker_id = ? ORDER BY timestamp DESC LIMIT 20',
        [id]
      );

      res.json({
        success: true,
        data: {
          ...worker,
          heartbeats: recentHeartbeats
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getExecutions(req, res, next) {
    try {
      const { id } = req.params;
      let query = `
        SELECT je.id, je.job_id, je.worker_id, je.attempt_number, je.status,
               je.started_at, je.completed_at, je.duration_ms, je.error_message,
               j.name as job_name, j.job_type, j.project_id, p.name as project_name, p.org_id
        FROM job_executions je
        JOIN jobs j ON je.job_id = j.id
        JOIN projects p ON j.project_id = p.id
        WHERE je.worker_id = ?
      `;
      const params = [id];

      if (req.user.role !== 'admin') {
        query += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      }

      const executions = await all(query, params);
      res.json({ success: true, data: executions });
    } catch (err) {
      next(err);
    }
  }

  static async getAutoscale(req, res, next) {
    try {
      const { AutoScalerService } = await import('../services/autoscaler.service.js');
      const metrics = await AutoScalerService.getFleetMetrics();
      res.json({ success: true, data: metrics });
    } catch (err) {
      next(err);
    }
  }

  static async updateAutoscale(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required to configure autoscaler' } });
      }
      const { AutoScalerService } = await import('../services/autoscaler.service.js');
      const updated = AutoScalerService.updateConfig(req.body);
      const metrics = await AutoScalerService.getFleetMetrics();
      res.json({ success: true, data: metrics, message: 'Auto-scaling configuration updated' });
    } catch (err) {
      next(err);
    }
  }

  static async scaleFleet(req, res, next) {
    try {
      if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Admin access required to scale fleet' } });
      }
      const { targetWorkers = 2 } = req.body;
      const { AutoScalerService } = await import('../services/autoscaler.service.js');
      AutoScalerService.updateConfig({ minWorkers: targetWorkers });
      await AutoScalerService.evaluateFleetCapacity();
      const metrics = await AutoScalerService.getFleetMetrics();
      res.json({ success: true, data: metrics, message: `Fleet scaled to target capacity: ${targetWorkers} workers` });
    } catch (err) {
      next(err);
    }
  }
}
