import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all } from '../database/db.js';

export const projectSchema = z.object({
  orgId: z.string().min(1).optional(),
  name: z.string().min(1),
  slug: z.string().min(1).optional(),
  description: z.string().optional().default('')
});

export const retryPolicySchema = z.object({
  name: z.string().min(1),
  strategy: z.enum(['none', 'fixed', 'linear_backoff', 'exponential_backoff']),
  maxRetries: z.number().int().min(0).max(20).default(3),
  baseDelaySeconds: z.number().int().min(1).default(5),
  maxDelaySeconds: z.number().int().min(1).default(300),
  backoffMultiplier: z.number().min(1.0).default(2.0)
});

export class ProjectController {
  static async list(req, res, next) {
    try {
      const { orgId } = req.query;

      if (req.user.role === 'admin') {
        if (orgId) {
          const projects = await all('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
          return res.json({ success: true, data: projects });
        }
        const projects = await all('SELECT * FROM projects ORDER BY created_at DESC');
        return res.json({ success: true, data: projects });
      }

      if (orgId) {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [orgId, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You do not have access to this organization' } });
        }
        const projects = await all('SELECT * FROM projects WHERE org_id = ? ORDER BY created_at DESC', [orgId]);
        return res.json({ success: true, data: projects });
      }

      const projects = await all(
        `SELECT p.*
         FROM projects p
         JOIN organization_members om ON p.org_id = om.org_id
         WHERE om.user_id = ?
         ORDER BY p.created_at DESC`,
        [req.user.id]
      );
      res.json({ success: true, data: projects });
    } catch (err) {
      next(err);
    }
  }

  static async create(req, res, next) {
    try {
      const { orgId, name, slug, description } = req.body;

      let targetOrgId = orgId;
      if (!targetOrgId) {
        const userOrg = await get('SELECT org_id FROM organization_members WHERE user_id = ? LIMIT 1', [req.user.id]);
        if (!userOrg) {
          return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'Please create or join an organization first' } });
        }
        targetOrgId = userOrg.org_id;
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [targetOrgId, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'You do not have permission to create projects in this organization' } });
        }
      }

      const finalSlug = slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
      const existing = await get('SELECT id FROM projects WHERE org_id = ? AND slug = ?', [targetOrgId, finalSlug]);

      if (existing) {
        return res.status(409).json({
          success: false,
          error: { code: 'CONFLICT', message: 'Project with this slug already exists in this organization' }
        });
      }

      const id = uuidv4();
      const now = new Date().toISOString();

      await run(
        'INSERT INTO projects (id, org_id, created_by_user_id, name, slug, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [id, targetOrgId, req.user.id, name, finalSlug, description || '', now, now]
      );

      const policyId = uuidv4();
      await run(
        'INSERT INTO retry_policies (id, project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds, backoff_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [policyId, id, 'Default Exponential Policy', 'exponential_backoff', 3, 5, 300, 2.0, now, now]
      );

      // Auto-provision 1 queue per service for this project with 2 shards each
      const { ensureServiceQueues } = await import('./queue.controller.js');
      await ensureServiceQueues(id);

      const project = await get('SELECT * FROM projects WHERE id = ?', [id]);
      res.status(201).json({ success: true, data: project });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const project = await get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [project.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied to this project' } });
        }
      }

      res.json({ success: true, data: project });
    } catch (err) {
      next(err);
    }
  }

  static async update(req, res, next) {
    try {
      const project = await get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [project.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const { name, description } = req.body;
      const now = new Date().toISOString();
      await run(
        'UPDATE projects SET name = COALESCE(?, name), description = COALESCE(?, description), updated_at = ? WHERE id = ?',
        [name, description, now, req.params.id]
      );
      const updated = await get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }

  static async delete(req, res, next) {
    try {
      const project = await get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [project.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      await run('DELETE FROM projects WHERE id = ?', [req.params.id]);
      res.json({ success: true, message: 'Project deleted successfully' });
    } catch (err) {
      next(err);
    }
  }

  static async getStats(req, res, next) {
    try {
      const { id } = req.params;
      const project = await get('SELECT * FROM projects WHERE id = ?', [id]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }
      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [project.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const queueCount = await get('SELECT COUNT(*) as count FROM queues WHERE project_id = ?', [id]);
      const jobCounts = await all('SELECT status, COUNT(*) as count FROM jobs WHERE project_id = ? GROUP BY status', [id]);
      const batchCount = await get('SELECT COUNT(*) as count FROM batches WHERE project_id = ?', [id]);
      const dlqCount = await get('SELECT COUNT(*) as count FROM dead_letter_queue WHERE project_id = ? AND resolution_status = "unresolved"', [id]);

      const statusMap = {
        scheduled: 0,
        queued: 0,
        claimed: 0,
        running: 0,
        completed: 0,
        failed: 0,
        dlq: 0,
        cancelled: 0
      };
      for (const row of jobCounts) {
        statusMap[row.status] = row.count;
      }

      res.json({
        success: true,
        data: {
          queues: queueCount.count,
          batches: batchCount.count,
          dlq: dlqCount.count,
          jobs: statusMap
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async listRetryPolicies(req, res, next) {
    try {
      const project = await get('SELECT * FROM projects WHERE id = ?', [req.params.id]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }
      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [project.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const policies = await all('SELECT * FROM retry_policies WHERE project_id = ? ORDER BY created_at ASC', [req.params.id]);
      res.json({ success: true, data: policies });
    } catch (err) {
      next(err);
    }
  }

  static async createRetryPolicy(req, res, next) {
    try {
      const { id: projectId } = req.params;
      const project = await get('SELECT * FROM projects WHERE id = ?', [projectId]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }
      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [project.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const { name, strategy, maxRetries, baseDelaySeconds, maxDelaySeconds, backoffMultiplier } = req.body;
      const id = uuidv4();
      const now = new Date().toISOString();

      await run(
        'INSERT INTO retry_policies (id, project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds, backoff_multiplier, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
          id,
          projectId,
          name,
          strategy,
          maxRetries !== undefined ? maxRetries : 3,
          baseDelaySeconds || 5,
          maxDelaySeconds || 300,
          backoffMultiplier || 2.0,
          now,
          now
        ]
      );

      const policy = await get('SELECT * FROM retry_policies WHERE id = ?', [id]);
      res.status(201).json({ success: true, data: policy });
    } catch (err) {
      next(err);
    }
  }
}
