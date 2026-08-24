import { get, all } from '../database/db.js';

export class ExecutionController {
  static async list(req, res, next) {
    try {
      const { jobId, workerId, status, page = 1, limit = 20 } = req.query;
      const parsedPage = Math.max(1, parseInt(page, 10) || 1);
      const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (parsedPage - 1) * parsedLimit;

      let orgFilter = '';
      const params = [];
      const countParams = [];

      if (req.user.role !== 'admin') {
        orgFilter = 'WHERE p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
        countParams.push(req.user.id);
      } else {
        orgFilter = 'WHERE 1=1';
      }

      let countSql = `
        SELECT COUNT(*) as total
        FROM job_executions je
        JOIN jobs j ON je.job_id = j.id
        JOIN projects p ON j.project_id = p.id
        ${orgFilter}
      `;
      let dataSql = `
        SELECT je.*, j.name as job_name, j.job_type, j.queue_id, p.name as project_name, q.name as queue_name
        FROM job_executions je
        JOIN jobs j ON je.job_id = j.id
        JOIN projects p ON j.project_id = p.id
        JOIN queues q ON j.queue_id = q.id
        ${orgFilter}
      `;

      if (jobId) {
        countSql += ' AND je.job_id = ?';
        dataSql += ' AND je.job_id = ?';
        params.push(jobId);
        countParams.push(jobId);
      }
      if (workerId) {
        countSql += ' AND je.worker_id = ?';
        dataSql += ' AND je.worker_id = ?';
        params.push(workerId);
        countParams.push(workerId);
      }
      if (status) {
        countSql += ' AND je.status = ?';
        dataSql += ' AND je.status = ?';
        params.push(status);
        countParams.push(status);
      }

      dataSql += ' ORDER BY je.started_at DESC LIMIT ? OFFSET ?';
      params.push(parsedLimit, offset);

      const totalResult = await get(countSql, countParams);
      const executions = await all(dataSql, params);

      res.json({
        success: true,
        data: {
          executions,
          pagination: {
            total: totalResult ? totalResult.total : 0,
            page: parsedPage,
            limit: parsedLimit,
            totalPages: Math.ceil((totalResult ? totalResult.total : 0) / parsedLimit)
          }
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getById(req, res, next) {
    try {
      const execution = await get(
        `SELECT je.*, j.name as job_name, j.job_type, j.payload as job_payload, j.result as job_result, q.name as queue_name, p.name as project_name, p.org_id
         FROM job_executions je
         JOIN jobs j ON je.job_id = j.id
         JOIN projects p ON j.project_id = p.id
         JOIN queues q ON j.queue_id = q.id
         WHERE je.id = ?`,
        [req.params.id]
      );

      if (!execution) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Execution not found' }
        });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [execution.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const logs = await all(
        'SELECT * FROM job_logs WHERE execution_id = ? ORDER BY timestamp ASC',
        [execution.id]
      );

      res.json({
        success: true,
        data: {
          ...execution,
          job_payload: JSON.parse(execution.job_payload || '{}'),
          job_result: execution.job_result ? JSON.parse(execution.job_result) : null,
          logs: logs.map((l) => ({ ...l, metadata: l.metadata ? JSON.parse(l.metadata) : null }))
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async getLogs(req, res, next) {
    try {
      const execution = await get(
        `SELECT je.id, p.org_id
         FROM job_executions je
         JOIN jobs j ON je.job_id = j.id
         JOIN projects p ON j.project_id = p.id
         WHERE je.id = ?`,
        [req.params.id]
      );

      if (!execution) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'Execution not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [execution.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const logs = await all(
        'SELECT * FROM job_logs WHERE execution_id = ? ORDER BY timestamp ASC',
        [req.params.id]
      );
      res.json({
        success: true,
        data: logs.map((l) => ({ ...l, metadata: l.metadata ? JSON.parse(l.metadata) : null }))
      });
    } catch (err) {
      next(err);
    }
  }
}
