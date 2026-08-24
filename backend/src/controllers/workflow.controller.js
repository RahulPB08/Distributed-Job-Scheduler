import { v4 as uuidv4 } from 'uuid';
import { z } from 'zod';
import { run, get, all, transaction } from '../database/db.js';

import { JOB_TYPE_TO_SERVICE_QUEUE, ensureServiceQueues } from './queue.controller.js';
import { ShardRouterService } from '../autoscaling/shard_router.service.js';

export const createDAGSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
  nodes: z.array(z.object({
    id: z.string().min(1), // local DAG node id, e.g. "task_a"
    name: z.string().min(1),
    queueId: z.string().optional().nullable(),
    jobType: z.enum(['http_request', 'db_query', 'cpu_compute', 'notification_event', 'custom_script']),
    payload: z.any().optional().default({}),
    priority: z.coerce.number().int().min(1).max(100).default(10),
    maxRetries: z.coerce.number().int().min(0).max(10).default(3)
  })).min(1),
  edges: z.array(z.object({
    from: z.string().min(1), // parent node local id
    to: z.string().min(1),   // child node local id
    condition: z.enum(['on_success', 'on_failure', 'always']).default('on_success')
  }))
});

export class WorkflowController {
  static async createDAG(req, res, next) {
    try {
      const parsed = createDAGSchema.parse(req.body);

      // Verify project ownership
      const project = await get('SELECT * FROM projects WHERE id = ?', [parsed.projectId]);
      if (!project) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Project not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [project.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      // Ensure dedicated service queues exist for this project
      await ensureServiceQueues(parsed.projectId);

      const now = new Date().toISOString();
      const nodeMap = new Map(); // localId -> dbJobId

      // Find root nodes (nodes with no incoming edges)
      const incomingTargets = new Set(parsed.edges.map(e => e.to));

      await transaction(async () => {
        // Step 1: Create job records for each node
        for (const node of parsed.nodes) {
          const dbJobId = uuidv4();
          nodeMap.set(node.id, dbJobId);

          let targetQueueId = node.queueId;
          if (!targetQueueId) {
            const expectedQueueName = JOB_TYPE_TO_SERVICE_QUEUE[node.jobType] || 'http-service-queue';
            const queueRow = await get('SELECT id FROM queues WHERE project_id = ? AND name = ?', [parsed.projectId, expectedQueueName]);
            targetQueueId = queueRow?.id;
          }

          if (!targetQueueId) {
            const anyQueue = await get('SELECT id FROM queues WHERE project_id = ? LIMIT 1', [parsed.projectId]);
            targetQueueId = anyQueue?.id;
          }

          // Shard routing
          const targetShard = await ShardRouterService.routeJob(targetQueueId, { strategy: 'least_loaded' });

          const isRoot = !incomingTargets.has(node.id);
          const initialStatus = isRoot ? 'queued' : 'scheduled'; // Root jobs start queued, children start scheduled/waiting

          await run(
            `INSERT INTO jobs (
              id, project_id, queue_id, shard_id, shard_index, name, job_type, status, priority, payload,
              timeout_seconds, scheduled_at, max_retries, retry_count,
              retry_strategy, retry_base_delay, retry_max_delay, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 60, ?, ?, 0, 'exponential_backoff', 5, 300, ?, ?)`,
            [
              dbJobId,
              parsed.projectId,
              targetQueueId,
              targetShard?.id || null,
              targetShard?.shard_index ?? 0,
              `[${parsed.name}] ${node.name}`,
              node.jobType,
              initialStatus,
              node.priority,
              JSON.stringify(node.payload || {}),
              now,
              node.maxRetries,
              now,
              now
            ]
          );
        }

        // Step 2: Insert dependency edges into workflow_dependencies
        for (const edge of parsed.edges) {
          const parentJobId = nodeMap.get(edge.from);
          const childJobId = nodeMap.get(edge.to);

          if (parentJobId && childJobId) {
            await run(
              `INSERT INTO workflow_dependencies (id, parent_job_id, child_job_id, condition, created_at)
               VALUES (?, ?, ?, ?, ?)`,
              [uuidv4(), parentJobId, childJobId, edge.condition, now]
            );
          }
        }
      });

      res.status(201).json({
        success: true,
        data: {
          workflowName: parsed.name,
          projectId: parsed.projectId,
          nodesCreated: parsed.nodes.length,
          edgesCreated: parsed.edges.length,
          rootJobsCount: parsed.nodes.length - incomingTargets.size,
          jobMapping: Object.fromEntries(nodeMap)
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async listDAGs(req, res, next) {
    try {
      const { projectId } = req.query;
      let sql = `
        SELECT DISTINCT wd.id as dependency_id, wd.parent_job_id, wd.child_job_id, wd.condition,
               pj.name as parent_name, pj.status as parent_status,
               cj.name as child_name, cj.status as child_status,
               pj.project_id, p.org_id
        FROM workflow_dependencies wd
        JOIN jobs pj ON wd.parent_job_id = pj.id
        JOIN jobs cj ON wd.child_job_id = cj.id
        JOIN projects p ON pj.project_id = p.id
        WHERE 1=1
      `;
      const params = [];

      if (req.user.role !== 'admin') {
        sql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
      }

      if (projectId) {
        sql += ' AND pj.project_id = ?';
        params.push(projectId);
      }

      const edges = await all(sql, params);
      res.json({ success: true, data: { edges } });
    } catch (err) {
      next(err);
    }
  }

  static async addDependency(req, res, next) {
    try {
      const { parentJobId, childJobId, condition = 'on_success' } = req.body;
      if (!parentJobId || !childJobId) {
        return res.status(400).json({ success: false, error: { message: 'parentJobId and childJobId are required' } });
      }
      if (parentJobId === childJobId) {
        return res.status(400).json({ success: false, error: { message: 'A job cannot depend on itself' } });
      }

      const parent = await get('SELECT j.*, p.org_id FROM jobs j JOIN projects p ON j.project_id = p.id WHERE j.id = ?', [parentJobId]);
      const child = await get('SELECT j.*, p.org_id FROM jobs j JOIN projects p ON j.project_id = p.id WHERE j.id = ?', [childJobId]);

      if (!parent || !child) {
        return res.status(404).json({ success: false, error: { message: 'Parent or child job not found' } });
      }

      if (req.user.role !== 'admin') {
        const parentMember = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [parent.org_id, req.user.id]);
        const childMember = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [child.org_id, req.user.id]);
        if (!parentMember || !childMember) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied to target jobs' } });
        }
      }

      const id = uuidv4();
      const now = new Date().toISOString();
      await run(
        `INSERT INTO workflow_dependencies (id, parent_job_id, child_job_id, condition, created_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(parent_job_id, child_job_id) DO UPDATE SET condition = excluded.condition`,
        [id, parentJobId, childJobId, condition, now]
      );

      // If child job is currently scheduled and parent is already completed, promote child
      if (parent.status === 'completed' || condition === 'always') {
        await run('UPDATE jobs SET status = "queued", updated_at = ? WHERE id = ? AND status = "scheduled"', [now, childJobId]);
      }

      res.status(201).json({ success: true, message: 'Dependency linked successfully' });
    } catch (err) {
      next(err);
    }
  }

  static async removeDependency(req, res, next) {
    try {
      const { id } = req.params;
      const dep = await get(
        `SELECT wd.*, p.org_id
         FROM workflow_dependencies wd
         JOIN jobs pj ON wd.parent_job_id = pj.id
         JOIN projects p ON pj.project_id = p.id
         WHERE wd.id = ? OR wd.parent_job_id = ? OR wd.child_job_id = ?
         LIMIT 1`,
        [id, id, id]
      );

      if (!dep) {
        return res.status(404).json({ success: false, error: { message: 'Dependency not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get('SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?', [dep.org_id, req.user.id]);
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      await run('DELETE FROM workflow_dependencies WHERE id = ? OR parent_job_id = ? OR child_job_id = ?', [id, id, id]);
      res.json({ success: true, message: 'Dependency removed' });
    } catch (err) {
      next(err);
    }
  }
}
