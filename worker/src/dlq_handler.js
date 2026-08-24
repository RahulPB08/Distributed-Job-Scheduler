import { v4 as uuidv4 } from 'uuid';
import { GoogleGenAI, Type } from '@google/genai';

export class DlqHandler {
  // Throttle state: track epoch timestamp of the last executed Gemini diagnostic call
  static lastDiagnosticTimestamp = 0;
  static THROTTLE_INTERVAL_MS = 10000; // 10-second cooldown to respect free-tier rate limits

  /**
   * Recursively deep-clones and sanitizes sensitive fields / PII from input objects
   * @param {any} data - Raw job or error payload
   * @returns {any} Sanitized payload safe for LLM transmission
   */
  static sanitizePII(data) {
    if (data === null || typeof data !== 'object') {
      return data;
    }

    const SENSITIVE_KEY_PATTERN = /password|token|auth|secret|cookie|jwt|credit_card/i;

    if (Array.isArray(data)) {
      return data.map((item) => DlqHandler.sanitizePII(item));
    }

    const sanitized = {};
    for (const [key, value] of Object.entries(data)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        sanitized[key] = '[REDACTED]';
      } else if (typeof value === 'object' && value !== null) {
        sanitized[key] = DlqHandler.sanitizePII(value);
      } else {
        sanitized[key] = value;
      }
    }

    return sanitized;
  }

  static generateFallbackDiagnostic(error, job) {
    const msg = (error?.message || String(error)).toLowerCase();
    let category = 'GENERAL_ERROR';
    let remediation = 'Review job payload and verify target URL / endpoint availability.';
    let severity = 'MEDIUM';

    if (msg.includes('404') || msg.includes('not found')) {
      category = 'ENDPOINT_NOT_FOUND';
      remediation = 'Verify the target URL and endpoint routing.';
      severity = 'HIGH';
    } else if (msg.includes('timeout') || msg.includes('etimedout')) {
      category = 'NETWORK_TIMEOUT';
      remediation = 'Increase timeout threshold or verify network connection.';
      severity = 'HIGH';
    } else if (msg.includes('auth') || msg.includes('401') || msg.includes('403')) {
      category = 'AUTHENTICATION_FAILURE';
      remediation = 'Update API key or authentication credentials.';
      severity = 'CRITICAL';
    }

    return {
      category,
      diagnosticSummary: `Job failed: ${error?.message || String(error)}`,
      probableCause: `Execution error in ${job?.job_type || 'task'}`,
      severity,
      suggestedFix: remediation,
      remediation,
      confidence: 0.95
    };
  }

  /**
   * Generates automated AI-driven root-cause diagnostic summary using Gemini 2.5 Flash
   * @param {Error|object|string} error - The caught runtime error or stack trace
   * @param {object} job - The background job execution context
   * @returns {Promise<object|null>} Structured diagnostic JSON matching the schema, or fallback heuristic
   */
  static async generateAIDiagnosticSummary(error, job) {
    const apiKey = process.env.GEMINI_API_KEY;

    // Fallback if API key is not configured
    if (!apiKey) {
      return DlqHandler.generateFallbackDiagnostic(error, job);
    }

    // Rate-limiting throttle: ensure at least 10 seconds between requests
    const now = Date.now();
    const timeSinceLastCall = now - DlqHandler.lastDiagnosticTimestamp;
    if (timeSinceLastCall < DlqHandler.THROTTLE_INTERVAL_MS) {
      return DlqHandler.generateFallbackDiagnostic(error, job);
    }

    try {
      // 1. Sanitize error and job metadata to remove sensitive credentials
      const sanitizedJob = DlqHandler.sanitizePII(
        typeof job === 'object' ? JSON.parse(JSON.stringify(job)) : { raw: String(job) }
      );

      const errorDetails = {
        message: error?.message || String(error),
        stack: error?.stack ? error.stack.split('\n').slice(0, 10).join('\n') : null,
        name: error?.name || 'Error'
      };

      // 2. Initialize the Google Gen AI client
      const ai = new GoogleGenAI({ apiKey });

      // 3. Define schema for Structured JSON Output (Controlled Generation)
      const diagnosticSchema = {
        type: Type.OBJECT,
        properties: {
          diagnosticSummary: {
            type: Type.STRING,
            description: 'Clear, concise description of what failed during job execution'
          },
          probableCause: {
            type: Type.STRING,
            description: 'Technical root-cause analysis diagnosing why the failure occurred'
          },
          severity: {
            type: Type.STRING,
            enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'],
            description: 'Severity assessment of the failure based on impact'
          },
          suggestedFix: {
            type: Type.STRING,
            description: 'Actionable step-by-step instructions to remediate the failure'
          }
        },
        required: ['diagnosticSummary', 'probableCause', 'severity', 'suggestedFix']
      };

      // 4. Update throttle timestamp before calling external API
      DlqHandler.lastDiagnosticTimestamp = Date.now();

      // 5. Invoke Gemini 2.5 Flash with controlled schema enforcement
      const prompt = `Analyze this background job failure and provide an automated diagnostic assessment:
Job Context:
${JSON.stringify(sanitizedJob, null, 2)}

Failure Details:
${JSON.stringify(errorDetails, null, 2)}`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
        config: {
          responseMimeType: 'application/json',
          responseSchema: diagnosticSchema,
          temperature: 0.2 // Low temperature for deterministic, factual diagnostics
        }
      });

      if (!response || !response.text) {
        throw new Error('Empty response received from Gemini API');
      }

      // Parse and return structured JSON
      const diagnosticResult = JSON.parse(response.text);
      return diagnosticResult;
    } catch (apiError) {
      console.warn('[AI_DIAGNOSTICS] Gemini API error, using fallback heuristic:', apiError?.message || apiError);
      return DlqHandler.generateFallbackDiagnostic(error, job);
    }
  }

  /**
   * Moves a permanently failed job into the Dead Letter Queue (DLQ)
   * @param {object} db - SQLite database connection
   * @param {object} job - Target job record
   * @param {Error|object} error - Failure error object
   * @param {number} attempts - Total execution attempts made
   * @returns {Promise<{dlqId: string, aiSummary: object|null}>}
   */
  static async moveToDlq(db, job, error, attempts) {
    const dlqId = `dlq_${uuidv4().replace(/-/g, '').slice(0, 16)}`;
    const now = new Date().toISOString();
    const failureReason = error?.message || String(error);
    const stackTrace = error?.stack || '';
    const payloadStr = typeof job?.payload === 'string' ? job.payload : JSON.stringify(job?.payload || {});

    // Generate automated AI root-cause diagnostic summary
    let aiSummary = null;
    try {
      aiSummary = await DlqHandler.generateAIDiagnosticSummary(error, job);
    } catch (e) {
      console.error('[DLQ_HANDLER] Unexpected error in diagnostic generation:', e.message);
    }

    return new Promise((resolve, reject) => {
      db.run(
        `INSERT INTO dead_letter_queue (
          id, job_id, queue_id, project_id, failure_reason, stack_trace,
          retry_attempts, payload, ai_diagnostic_summary, archived_at, resolution_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unresolved')`,
        [
          dlqId,
          job.id,
          job.queue_id,
          job.project_id,
          failureReason,
          stackTrace,
          attempts,
          payloadStr,
          aiSummary ? JSON.stringify(aiSummary) : null,
          now
        ],
        function (err) {
          if (err) return reject(err);
          resolve({ dlqId, aiSummary });
        }
      );
    });
  }
}
