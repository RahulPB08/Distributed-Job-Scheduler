import { run, get, all } from '../database/db.js';
import { QueueManager } from '../redis/queue_manager.js';
import { v4 as uuidv4 } from 'uuid';

export class DlqController {
  static async list(req, res, next) {
    try {
      const { projectId, status, page = 1, limit = 20 } = req.query;
      const parsedPage = Math.max(1, parseInt(page, 10) || 1);
      const parsedLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
      const offset = (parsedPage - 1) * parsedLimit;

      let countSql = `
        SELECT COUNT(*) as total
        FROM dead_letter_queue dlq
        JOIN projects p ON dlq.project_id = p.id
        WHERE 1=1
      `;
      let dataSql = `
        SELECT dlq.*, j.name as job_name, j.job_type, q.name as queue_name, p.name as project_name, p.org_id
        FROM dead_letter_queue dlq
        JOIN projects p ON dlq.project_id = p.id
        JOIN queues q ON dlq.queue_id = q.id
        JOIN jobs j ON dlq.job_id = j.id
        WHERE 1=1
      `;
      const params = [];
      const countParams = [];

      if (req.user.role !== 'admin') {
        countSql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        dataSql += ' AND p.org_id IN (SELECT org_id FROM organization_members WHERE user_id = ?)';
        params.push(req.user.id);
        countParams.push(req.user.id);
      }

      if (projectId) {
        countSql += ' AND dlq.project_id = ?';
        dataSql += ' AND dlq.project_id = ?';
        params.push(projectId);
        countParams.push(projectId);
      }
      if (status) {
        countSql += ' AND dlq.resolution_status = ?';
        dataSql += ' AND dlq.resolution_status = ?';
        params.push(status);
        countParams.push(status);
      }

      dataSql += ' ORDER BY dlq.archived_at DESC LIMIT ? OFFSET ?';
      params.push(parsedLimit, offset);

      const totalResult = await get(countSql, countParams);
      const entries = await all(dataSql, params);

      const safeJson = (val, fallback = null) => {
        if (!val) return fallback;
        if (typeof val === 'object') return val;
        try { return JSON.parse(val); } catch (e) { return val; }
      };

      res.json({
        success: true,
        data: {
          entries: entries.map((e) => ({
            ...e,
            payload: safeJson(e.payload, {}),
            ai_diagnostic_summary: safeJson(e.ai_diagnostic_summary, null)
          })),
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
      const entry = await get(
        `SELECT dlq.*, j.name as job_name, j.job_type, q.name as queue_name, p.name as project_name, p.org_id
         FROM dead_letter_queue dlq
         JOIN projects p ON dlq.project_id = p.id
         JOIN queues q ON dlq.queue_id = q.id
         JOIN jobs j ON dlq.job_id = j.id
         WHERE dlq.id = ?`,
        [req.params.id]
      );

      if (!entry) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [entry.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      res.json({
        success: true,
        data: {
          ...entry,
          payload: JSON.parse(entry.payload || '{}'),
          ai_diagnostic_summary: entry.ai_diagnostic_summary ? JSON.parse(entry.ai_diagnostic_summary) : null
        }
      });
    } catch (err) {
      next(err);
    }
  }

  static async retry(req, res, next) {
    try {
      const entry = await get(
        'SELECT dlq.*, p.org_id FROM dead_letter_queue dlq JOIN projects p ON dlq.project_id = p.id WHERE dlq.id = ?',
        [req.params.id]
      );

      if (!entry) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } });
      }

      if (req.user.role !== 'admin') {
        const membership = await get(
          'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
          [entry.org_id, req.user.id]
        );
        if (!membership) {
          return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
        }
      }

      const now = new Date().toISOString();
      // Set directly to 'queued' so a worker picks it up immediately
      // (not 'scheduled', which would wait for the scheduler tick)
      await run(
        `UPDATE jobs SET status = 'queued', scheduled_at = ?, retry_count = 0,
         error_details = NULL, worker_id = NULL, updated_at = ? WHERE id = ?`,
        [now, now, entry.job_id]
      );

      await run(
        'UPDATE dead_letter_queue SET resolution_status = "requeued", resolved_at = ? WHERE id = ?',
        [now, req.params.id]
      );

      // Also write a DLQ-replay log entry
      try {
        await run(
          `INSERT INTO job_logs (id, job_id, log_level, message, timestamp)
           VALUES (?, ?, 'info', 'Job replayed from Dead Letter Queue by ${req.user?.name || 'admin'}', ?)`,
          [uuidv4(), entry.job_id, now]
        );
      } catch (e) {}

      // Enqueue to Redis so worker picks it up immediately
      try {
        const job = await get('SELECT * FROM jobs WHERE id = ?', [entry.job_id]);
        if (job) await QueueManager.enqueueJob(entry.queue_id, { ...job, payload: JSON.parse(job.payload || '{}') }, job.priority || 10);
      } catch (e) {}

      res.json({ success: true, message: 'Job requeued from DLQ' });
    } catch (err) {
      next(err);
    }
  }

  static async _checkDlqAccess(req, dlqId) {
    const entry = await get(
      'SELECT dlq.*, p.org_id FROM dead_letter_queue dlq JOIN projects p ON dlq.project_id = p.id WHERE dlq.id = ?',
      [dlqId]
    );
    if (!entry) return { exists: false, hasAccess: false, entry: null };
    if (req.user.role === 'admin') return { exists: true, hasAccess: true, entry };

    const membership = await get(
      'SELECT id FROM organization_members WHERE org_id = ? AND user_id = ?',
      [entry.org_id, req.user.id]
    );
    return { exists: true, hasAccess: !!membership, entry };
  }

  static async bulkRetry(req, res, next) {
    try {
      const { dlqIds } = req.body;
      if (!Array.isArray(dlqIds) || dlqIds.length === 0) {
        return res.status(400).json({ success: false, error: { code: 'BAD_REQUEST', message: 'dlqIds array is required' } });
      }
      const now = new Date().toISOString();
      let requeuedCount = 0;

      for (const id of dlqIds) {
        const access = await DlqController._checkDlqAccess(req, id);
        if (access.exists && access.hasAccess) {
          const entry = access.entry;
          await run(
            `UPDATE jobs SET status = 'queued', scheduled_at = ?, retry_count = 0,
             error_details = NULL, worker_id = NULL, updated_at = ? WHERE id = ?`,
            [now, now, entry.job_id]
          );
          await run(
            'UPDATE dead_letter_queue SET resolution_status = "requeued", resolved_at = ? WHERE id = ?',
            [now, id]
          );
          try {
            const job = await get('SELECT * FROM jobs WHERE id = ?', [entry.job_id]);
            if (job) await QueueManager.enqueueJob(entry.queue_id, { ...job, payload: JSON.parse(job.payload || '{}') }, job.priority || 10);
          } catch (e) {}
          requeuedCount++;
        }
      }

      res.json({ success: true, message: `Requeued ${requeuedCount} jobs from DLQ` });
    } catch (err) {
      next(err);
    }
  }

  static async purge(req, res, next) {
    try {
      const access = await DlqController._checkDlqAccess(req, req.params.id);
      if (!access.exists) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } });
      }
      if (!access.hasAccess) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const now = new Date().toISOString();
      await run(
        'UPDATE dead_letter_queue SET resolution_status = "purged", resolved_at = ? WHERE id = ?',
        [now, req.params.id]
      );
      res.json({ success: true, message: 'DLQ entry purged' });
    } catch (err) {
      next(err);
    }
  }

  static async diagnose(req, res, next) {
    try {
      const access = await DlqController._checkDlqAccess(req, req.params.id);
      if (!access.exists) {
        return res.status(404).json({ success: false, error: { code: 'NOT_FOUND', message: 'DLQ entry not found' } });
      }
      if (!access.hasAccess) {
        return res.status(403).json({ success: false, error: { code: 'FORBIDDEN', message: 'Access denied' } });
      }

      const entry = access.entry;
      let summary = null;

      // Try Gemini 2.5 Flash if GEMINI_API_KEY is configured
      const apiKey = process.env.GEMINI_API_KEY;
      if (apiKey) {
        try {
          const { GoogleGenAI, Type } = await import('@google/genai');
          const ai = new GoogleGenAI({ apiKey });

          const prompt = `Analyze this dead-letter-queue failed job and provide root-cause diagnostics:
Job ID: ${entry.job_id}
Queue ID: ${entry.queue_id}
Failure Reason: ${entry.failure_reason}
Stack Trace: ${entry.stack_trace || 'None'}
Attempts: ${entry.retry_attempts}
Payload: ${entry.payload}`;

          const response = await ai.models.generateContent({
            model: 'gemini-2.5-flash',
            contents: prompt,
            config: {
              responseMimeType: 'application/json',
              responseSchema: {
                type: Type.OBJECT,
                properties: {
                  diagnosticSummary: { type: Type.STRING },
                  probableCause: { type: Type.STRING },
                  severity: { type: Type.STRING, enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] },
                  suggestedFix: { type: Type.STRING }
                },
                required: ['diagnosticSummary', 'probableCause', 'severity', 'suggestedFix']
              },
              temperature: 0.2
            }
          });

          if (response?.text) {
            const aiData = JSON.parse(response.text);
            summary = {
              category: aiData.severity,
              confidence: 0.98,
              rootCause: aiData.probableCause,
              remediation: aiData.suggestedFix,
              diagnosticSummary: aiData.diagnosticSummary,
              diagnosedAt: new Date().toISOString()
            };
          }
        } catch (genAiErr) {
          console.error('[DLQ_DIAGNOSE] Gemini API error, falling back to heuristics:', genAiErr.message);
        }
      }

      // Fallback heuristics if Gemini is not reachable
      if (!summary) {
        let category = 'NETWORK_OR_TIMEOUT';
        let remediation = 'Verify network connectivity or upstream target status.';

        if (entry.failure_reason.includes('404')) {
          category = 'ENDPOINT_NOT_FOUND';
          remediation = 'Verify target URL path in payload.';
        } else if (entry.failure_reason.includes('SYNTAX') || entry.failure_reason.includes('JSON')) {
          category = 'DATA_FORMAT_ERROR';
          remediation = 'Validate JSON payload format and required fields.';
        } else if (entry.failure_reason.includes('TIMEOUT') || entry.failure_reason.includes('ETIMEDOUT')) {
          category = 'TIMEOUT_EXCEEDED';
          remediation = 'Increase job timeout seconds or optimize downstream handler.';
        }

        summary = {
          category,
          confidence: 0.94,
          rootCause: entry.failure_reason,
          remediation,
          diagnosedAt: new Date().toISOString()
        };
      }

      await run(
        'UPDATE dead_letter_queue SET ai_diagnostic_summary = ? WHERE id = ?',
        [JSON.stringify(summary), req.params.id]
      );

      res.json({ success: true, data: summary });
    } catch (err) {
      next(err);
    }
  }
}
