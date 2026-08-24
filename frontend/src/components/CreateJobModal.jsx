import React, { useState, useEffect } from 'react';
import { Modal } from './Modal.jsx';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { Layers, ShieldCheck, Zap, Sparkles, Clock, Calendar, Repeat, AlertCircle } from 'lucide-react';

export const CreateJobModal = ({ isOpen, onClose, onJobCreated }) => {
  const { currentProject, projects } = useProject();
  const [activeType, setActiveType] = useState('immediate');
  const [name, setName] = useState('');
  const [jobType, setJobType] = useState('http_request');
  const [priority, setPriority] = useState(10);
  const [maxRetries, setMaxRetries] = useState(3);
  const [retryStrategy, setRetryStrategy] = useState('exponential_backoff');
  const [retryBaseDelay, setRetryBaseDelay] = useState(5);
  const [delaySeconds, setDelaySeconds] = useState(10);
  const [scheduledAt, setScheduledAt] = useState('');
  const [cronExpression, setCronExpression] = useState('*/5 * * * *');
  const [payloadJson, setPayloadJson] = useState('{\n  "url": "https://httpbin.org/get",\n  "method": "GET"\n}');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const handleJobTypeChange = (type) => {
    setJobType(type);
    if (type === 'http_request') {
      setPayloadJson('{\n  "url": "https://httpbin.org/get",\n  "method": "GET"\n}');
    } else if (type === 'db_query') {
      setPayloadJson('{\n  "operation": "bulk_insert",\n  "table": "user_telemetry",\n  "records": [\n    { "metric": "page_view", "latency": 32 }\n  ]\n}');
    } else if (type === 'cpu_compute') {
      setPayloadJson('{\n  "type": "hash_iterations",\n  "algorithm": "sha256",\n  "iterations": 150000\n}');
    } else if (type === 'notification_event') {
      setPayloadJson('{\n  "channel": "email",\n  "recipient": "ops@djs.io",\n  "event": "DEPLOYMENT_SUCCESSFUL"\n}');
    } else if (type === 'custom_script') {
      setPayloadJson('{\n  "script": "console.log(\\"Processing custom workload\\")",\n  "timeout": 5000\n}');
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    const effectiveProjectId = currentProject?.id || (projects && projects.length > 0 ? projects[0].id : null);
    if (!effectiveProjectId) {
      setError('Please select or create a project workspace first');
      return;
    }

    if (!name.trim()) {
      setError('Job name is required');
      return;
    }

    let parsedPayload = {};
    try {
      parsedPayload = payloadJson ? JSON.parse(payloadJson) : {};
    } catch (err) {
      setError('Payload is not valid JSON: ' + err.message);
      return;
    }

    setLoading(true);
    setError(null);

    try {
      if (activeType === 'recurring') {
        await api.schedules.create({
          projectId: effectiveProjectId,
          name: name.trim(),
          jobType,
          cronExpression: cronExpression.trim(),
          payload: parsedPayload,
          priority: parseInt(priority, 10) || 10
        });
      } else {
        const body = {
          projectId: effectiveProjectId,
          name: name.trim(),
          jobType,
          payload: parsedPayload,
          priority: parseInt(priority, 10) || 10,
          timeoutSeconds: 60,
          maxRetries: retryStrategy === 'none' ? 0 : parseInt(maxRetries, 10),
          retryStrategy,
          retryBaseDelay: parseInt(retryBaseDelay, 10) || 5
        };

        if (activeType === 'delayed') {
          body.delaySeconds = parseInt(delaySeconds, 10) || 10;
        } else if (activeType === 'scheduled' && scheduledAt) {
          body.scheduledAt = new Date(scheduledAt).toISOString();
        }

        await api.jobs.create(body);
      }

      onJobCreated?.();
      onClose();
    } catch (err) {
      setError(err.message || 'Failed to dispatch job');
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Dispatch Background Job" maxWidth="max-w-2xl">
      <form onSubmit={handleSubmit} className="space-y-4 text-xs">
        {error && (
          <div className="flex items-center gap-2 p-3 rounded-xl bg-rose-950/40 border border-rose-800 text-rose-200">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        {/* Schedule Mode Switcher */}
        <div className="grid grid-cols-4 gap-1 p-1 rounded-xl bg-slate-950/80 border border-slate-800/80">
          <button
            type="button"
            onClick={() => setActiveType('immediate')}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-lg font-semibold transition-all ${
              activeType === 'immediate'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Zap className="w-3.5 h-3.5" />
            <span>Immediate</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveType('delayed')}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-lg font-semibold transition-all ${
              activeType === 'delayed'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Delayed</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveType('scheduled')}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-lg font-semibold transition-all ${
              activeType === 'scheduled'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Calendar className="w-3.5 h-3.5" />
            <span>One-Off</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveType('recurring')}
            className={`flex items-center justify-center gap-1.5 py-2 rounded-lg font-semibold transition-all ${
              activeType === 'recurring'
                ? 'bg-indigo-600 text-white shadow-md'
                : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Repeat className="w-3.5 h-3.5" />
            <span>Cron Routine</span>
          </button>
        </div>

        {/* Form Inputs */}
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-semibold text-slate-300 mb-1">Job Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Process User Batch Records"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="djs-input text-xs"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1">Target Service Queue</label>
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-indigo-500/20 bg-indigo-950/20 text-indigo-300 text-xs font-mono">
              <Layers className="w-4 h-4 text-indigo-400 shrink-0" />
              <span className="truncate">Auto: {jobType.replace('_', '-')}-queue (2+ Shards)</span>
            </div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block font-semibold text-slate-300 mb-1">Execution Service</label>
            <select
              value={jobType}
              onChange={(e) => handleJobTypeChange(e.target.value)}
              className="djs-select text-xs"
            >
              <option value="http_request">HTTP Webhook (Async Fetch)</option>
              <option value="db_query">Database Operation (SQL / KV)</option>
              <option value="cpu_compute">CPU Compute (Worker Threads)</option>
              <option value="notification_event">Notification Dispatcher</option>
              <option value="custom_script">Custom Script Execution</option>
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1">Priority (1-100)</label>
            <input
              type="number"
              min="1"
              max="100"
              value={priority}
              onChange={(e) => setPriority(e.target.value)}
              className="djs-input text-xs"
            />
          </div>
        </div>

        {activeType === 'immediate' && (
          <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-3.5 space-y-2.5">
            <h4 className="font-semibold text-slate-300 flex items-center gap-2 text-xs">
              <ShieldCheck className="w-4 h-4 text-emerald-400" />
              <span>Retry Policy &amp; Failure Backoff</span>
            </h4>
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block font-medium text-slate-400 mb-1">Strategy</label>
                <select
                  value={retryStrategy}
                  onChange={(e) => setRetryStrategy(e.target.value)}
                  className="djs-select text-xs py-1.5"
                >
                  <option value="none">None (0 retries -&gt; DLQ)</option>
                  <option value="fixed">Fixed Delay</option>
                  <option value="linear_backoff">Linear Backoff</option>
                  <option value="exponential_backoff">Exponential Backoff</option>
                </select>
              </div>

              <div>
                <label className="block font-medium text-slate-400 mb-1">Max Retries</label>
                <input
                  type="number"
                  min="0"
                  max="10"
                  value={retryStrategy === 'none' ? 0 : maxRetries}
                  disabled={retryStrategy === 'none'}
                  onChange={(e) => setMaxRetries(e.target.value)}
                  className="djs-input text-xs py-1.5 disabled:opacity-40"
                />
              </div>

              <div>
                <label className="block font-medium text-slate-400 mb-1">Base Delay (s)</label>
                <input
                  type="number"
                  min="1"
                  max="3600"
                  value={retryBaseDelay}
                  disabled={retryStrategy === 'none'}
                  onChange={(e) => setRetryBaseDelay(e.target.value)}
                  className="djs-input text-xs py-1.5 disabled:opacity-40"
                />
              </div>
            </div>
          </div>
        )}

        {activeType === 'delayed' && (
          <div>
            <label className="block font-semibold text-slate-300 mb-1">Delay Duration (Seconds)</label>
            <input
              type="number"
              min="1"
              value={delaySeconds}
              onChange={(e) => setDelaySeconds(e.target.value)}
              className="djs-input text-xs"
            />
          </div>
        )}

        {activeType === 'scheduled' && (
          <div>
            <label className="block font-semibold text-slate-300 mb-1">Scheduled Execution Time (Local / UTC)</label>
            <input
              type="datetime-local"
              required
              value={scheduledAt}
              onChange={(e) => setScheduledAt(e.target.value)}
              className="djs-input text-xs"
            />
          </div>
        )}

        {activeType === 'recurring' && (
          <div>
            <label className="block font-semibold text-slate-300 mb-1">Cron Expression (5-Fields Standard)</label>
            <input
              type="text"
              required
              placeholder="*/5 * * * *"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              className="djs-input text-xs font-mono"
            />
            <p className="text-[10px] text-slate-400 mt-1">Format: Minute Hour Day-of-Month Month Day-of-Week (e.g. "*/5 * * * *" every 5 mins)</p>
          </div>
        )}

        <div>
          <label className="block font-semibold text-slate-300 mb-1">Job Payload (JSON)</label>
          <textarea
            rows={4}
            value={payloadJson}
            onChange={(e) => setPayloadJson(e.target.value)}
            className="djs-textarea text-xs font-mono"
          />
        </div>

        <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
          <button
            type="button"
            onClick={onClose}
            className="btn-ghost text-xs"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={loading}
            className="btn-primary text-xs"
          >
            <Zap className="w-3.5 h-3.5" />
            <span>{loading ? 'Submitting...' : 'Dispatch Job'}</span>
          </button>
        </div>
      </form>
    </Modal>
  );
};
