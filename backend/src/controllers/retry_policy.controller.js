import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all } from '../database/db.js';

// ─── Validation ────────────────────────────────────────────────────────────────
const createSchema = z.object({
  name: z.string().min(1).max(100),
  strategy: z.enum(['none', 'fixed', 'linear_backoff', 'exponential_backoff']),
  maxRetries: z.number().int().min(0).max(20).default(3),
  baseDelaySeconds: z.number().int().min(1).max(3600).default(5),
  maxDelaySeconds: z.number().int().min(1).max(86400).default(300),
  backoffMultiplier: z.number().min(1).max(10).default(2.0)
});

const updateSchema = createSchema.partial();

/**
 * RetryPolicyController — CRUD for retry policies scoped to a project.
 * Policies are reusable strategy definitions (fixed / linear / exponential).
 */
export class RetryPolicyController {

  /** GET /api/projects/:projectId/retry-policies */
  static async list(req, res, next) {
    try {
      const { projectId } = req.params;
      await RetryPolicyController._checkProjectAccess(req, projectId, res);
      if (res.headersSent) return;

      const policies = await all(
        `SELECT rp.*, COUNT(j.id) as jobs_using
         FROM retry_policies rp
         LEFT JOIN jobs j ON j.retry_policy_id = rp.id
         WHERE rp.project_id = ?
         GROUP BY rp.id
         ORDER BY rp.created_at ASC`,
        [projectId]
      );
      res.json({ success: true, data: policies });
    } catch (err) {
      next(err);
    }
  }

  /** POST /api/projects/:projectId/retry-policies */
  static async create(req, res, next) {
    try {
      const { projectId } = req.params;
      await RetryPolicyController._checkProjectAccess(req, projectId, res);
      if (res.headersSent) return;

      const parsed = createSchema.parse(req.body);
      const id = uuidv4();
      const now = new Date().toISOString();

      await run(
        `INSERT INTO retry_policies (id, project_id, name, strategy, max_retries, base_delay_seconds, max_delay_seconds, backoff_multiplier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [id, projectId, parsed.name, parsed.strategy, parsed.maxRetries, parsed.baseDelaySeconds, parsed.maxDelaySeconds, parsed.backoffMultiplier, now, now]
      );

      const policy = await get('SELECT * FROM retry_policies WHERE id = ?', [id]);
      res.status(201).json({ success: true, data: policy });
    } catch (err) {
      next(err);
    }
  }

  /** GET /api/retry-policies/:id */
  static async getById(req, res, next) {
    try {
      const policy = await get('SELECT * FROM retry_policies WHERE id = ?', [req.params.id]);
      if (!policy) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Retry policy not found' } });
      }
      await RetryPolicyController._checkProjectAccess(req, policy.project_id, res);
      if (res.headersSent) return;
      res.json({ success: true, data: policy });
    } catch (err) {
      next(err);
    }
  }

  /** PATCH /api/retry-policies/:id */
  static async update(req, res, next) {
    try {
      const policy = await get('SELECT * FROM retry_policies WHERE id = ?', [req.params.id]);
      if (!policy) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Retry policy not found' } });
      }
      await RetryPolicyController._checkProjectAccess(req, policy.project_id, res);
      if (res.headersSent) return;

      const parsed = updateSchema.parse(req.body);
      const now = new Date().toISOString();
      const fields = [];
      const vals = [];

      if (parsed.name !== undefined)              { fields.push('name = ?');               vals.push(parsed.name); }
      if (parsed.strategy !== undefined)          { fields.push('strategy = ?');           vals.push(parsed.strategy); }
      if (parsed.maxRetries !== undefined)        { fields.push('max_retries = ?');        vals.push(parsed.maxRetries); }
      if (parsed.baseDelaySeconds !== undefined)  { fields.push('base_delay_seconds = ?'); vals.push(parsed.baseDelaySeconds); }
      if (parsed.maxDelaySeconds !== undefined)   { fields.push('max_delay_seconds = ?');  vals.push(parsed.maxDelaySeconds); }
      if (parsed.backoffMultiplier !== undefined) { fields.push('backoff_multiplier = ?'); vals.push(parsed.backoffMultiplier); }

      if (fields.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'No fields to update' } });
      }

      fields.push('updated_at = ?');
      vals.push(now);
      vals.push(req.params.id);

      await run(`UPDATE retry_policies SET ${fields.join(', ')} WHERE id = ?`, vals);
      const updated = await get('SELECT * FROM retry_policies WHERE id = ?', [req.params.id]);
      res.json({ success: true, data: updated });
    } catch (err) {
      next(err);
    }
  }

  /** DELETE /api/retry-policies/:id */
  static async delete(req, res, next) {
    try {
      const policy = await get('SELECT * FROM retry_policies WHERE id = ?', [req.params.id]);
      if (!policy) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Retry policy not found' } });
      }
      await RetryPolicyController._checkProjectAccess(req, policy.project_id, res);
      if (res.headersSent) return;

      // Check if any queues or jobs still use this policy
      const usedByQueue = await get('SELECT id FROM queues WHERE retry_policy_id = ? LIMIT 1', [req.params.id]);
      if (usedByQueue) {
        return res.status(409).json({
          success: false,
          error: { code: 'CONFLICT', message: 'Policy is assigned to one or more queues. Unassign it first.' }
        });
      }

      await run('DELETE FROM retry_policies WHERE id = ?', [req.params.id]);
      res.json({ success: true, message: 'Retry policy deleted' });
    } catch (err) {
      next(err);
    }
  }

  /** Helper: check if req.user has access to the project (member of its org or global admin) */
  static async _checkProjectAccess(req, projectId, res) {
    const project = await get('SELECT org_id FROM projects WHERE id = ?', [projectId]);
    if (!project) {
      res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      return;
    }
    if (req.user.role === 'admin') return;

    const membership = await get(
      'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
      [project.org_id, req.user.id]
    );
    if (!membership) {
      res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
    }
  }
}
