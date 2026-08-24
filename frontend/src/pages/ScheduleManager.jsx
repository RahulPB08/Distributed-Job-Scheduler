import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Play, Pause, Trash2, Zap, RefreshCw, CalendarClock, Clock, CheckCircle2, AlertCircle } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';

export const ScheduleManager = () => {
  const { currentProject } = useProject();
  const { lastEvent } = useWebSocket();
  const [schedules, setSchedules] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);

  const [name, setName] = useState('');
  const [jobType, setJobType] = useState('http_request');
  const [cronExpression, setCronExpression] = useState('*/5 * * * *');
  const [priority, setPriority] = useState(10);
  const [payloadJson, setPayloadJson] = useState('{\n  "url": "https://httpbin.org/get",\n  "method": "GET"\n}');
  const [formError, setFormError] = useState(null);

  const fetchSchedules = useCallback(async () => {
    if (!currentProject) return;
    try {
      setIsRefreshing(true);
      const sRes = await api.schedules.list(currentProject.id);
      setSchedules(sRes?.data || []);
    } catch (err) {
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [currentProject?.id]);

  useEffect(() => {
    fetchSchedules();
    const interval = setInterval(fetchSchedules, 3000);
    return () => clearInterval(interval);
  }, [fetchSchedules]);

  useEffect(() => {
    if (lastEvent && (lastEvent.type?.startsWith('SCHEDULE_') || lastEvent.type?.startsWith('JOB_'))) {
      fetchSchedules();
    }
  }, [lastEvent, fetchSchedules]);

  const handleCreateSchedule = async (e) => {
    e.preventDefault();
    setFormError(null);

    try {
      await api.schedules.create({
        projectId: currentProject.id,
        name,
        jobType,
        cronExpression,
        payload: JSON.parse(payloadJson),
        priority: parseInt(priority, 10)
      });
      setIsCreateModalOpen(false);
      setName('');
      fetchSchedules();
    } catch (err) {
      setFormError(err.message || 'Failed to create schedule');
    }
  };

  const handleToggle = async (scheduleId) => {
    try {
      await api.schedules.toggle(scheduleId);
      fetchSchedules();
    } catch (err) {}
  };

  const handleTrigger = async (scheduleId) => {
    try {
      await api.schedules.trigger(scheduleId);
      fetchSchedules();
    } catch (err) {}
  };

  const handleDelete = async (scheduleId) => {
    if (window.confirm('Delete this recurring schedule?')) {
      try {
        await api.schedules.delete(scheduleId);
        fetchSchedules();
      } catch (err) {}
    }
  };

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-400">
            <CalendarClock className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Cron Scheduler &amp; Recurring Jobs</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Standard 5-field cron routines evaluated and dispatched autonomously with starvation prevention
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchSchedules}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Schedules"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="btn-primary text-xs"
          >
            <Plus className="w-4 h-4" />
            <span>New Schedule</span>
          </button>
        </div>
      </div>

      {/* Schedule Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="djs-table">
            <thead>
              <tr>
                <th>Schedule Name</th>
                <th>Cron Expression</th>
                <th>Auto Service Queue</th>
                <th>Service Type</th>
                <th>Runs</th>
                <th>Next Run (UTC)</th>
                <th>Status</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="8" className="py-12 text-center text-slate-500">
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      <span>Evaluating cron schedules...</span>
                    </div>
                  </td>
                </tr>
              ) : schedules.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-12 text-center text-slate-500">
                    No recurring schedules configured yet. Click "New Schedule" to create automated cron jobs.
                  </td>
                </tr>
              ) : (
                schedules.map((s) => (
                  <tr key={s.id} className="transition-all hover:bg-slate-800/40">
                    <td>
                      <p className="font-semibold text-slate-100">{s.name}</p>
                      <p className="text-[10px] font-mono text-slate-500">{s.id}</p>
                    </td>
                    <td>
                      <span className="font-mono text-indigo-300 font-bold px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-xs">
                        {s.cron_expression || 'One-shot'}
                      </span>
                    </td>
                    <td>
                      <span className="font-mono text-xs text-slate-300">
                        {s.queue_name || `${s.job_type.replace('_', '-')}-queue`}
                      </span>
                    </td>
                    <td>
                      <Badge status={s.job_type} />
                    </td>
                    <td className="font-mono text-xs text-slate-200 font-bold">
                      {s.total_runs || 0}
                    </td>
                    <td className="font-mono text-xs text-slate-400">
                      {s.next_run_at ? new Date(s.next_run_at).toLocaleString() : 'Pending tick...'}
                    </td>
                    <td>
                      {s.is_active ? (
                        <Badge status="healthy" text="Active" />
                      ) : (
                        <Badge status="stopped" text="Paused" />
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleTrigger(s.id)}
                          title="Run Immediately"
                          className="btn-secondary text-[11px] py-1 px-2 text-indigo-300"
                        >
                          Run Now
                        </button>
                        <button
                          onClick={() => handleToggle(s.id)}
                          title={s.is_active ? 'Pause Schedule' : 'Resume Schedule'}
                          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
                        >
                          {s.is_active ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 text-emerald-400" />}
                        </button>
                        <button
                          onClick={() => handleDelete(s.id)}
                          title="Delete Schedule"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-all"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Create Schedule Modal */}
      <Modal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} title="Create Recurring Cron Routine" maxWidth="max-w-xl">
        <form onSubmit={handleCreateSchedule} className="space-y-4 text-xs">
          {formError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
              {formError}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Schedule Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Hourly Data Pipeline Audit"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="djs-input"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">Execution Service</label>
              <select
                value={jobType}
                onChange={(e) => setJobType(e.target.value)}
                className="djs-select"
              >
                <option value="http_request">HTTP Webhook</option>
                <option value="db_query">Database Query</option>
                <option value="cpu_compute">CPU Compute</option>
                <option value="notification_event">Notification</option>
                <option value="custom_script">Custom Script</option>
              </select>
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">Priority (1 - 100)</label>
              <input
                type="number"
                min="1"
                max="100"
                value={priority}
                onChange={(e) => setPriority(e.target.value)}
                className="djs-input"
              />
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Cron Expression (5-Fields)</label>
            <input
              type="text"
              required
              placeholder="*/5 * * * *"
              value={cronExpression}
              onChange={(e) => setCronExpression(e.target.value)}
              className="djs-input font-mono"
            />
            <p className="text-[11px] text-slate-500 mt-1">Format: Minute Hour Day Month Weekday (e.g. "*/10 * * * *" every 10 min)</p>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Job Payload JSON</label>
            <textarea
              rows={3}
              value={payloadJson}
              onChange={(e) => setPayloadJson(e.target.value)}
              className="djs-textarea"
            />
          </div>

          <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setIsCreateModalOpen(false)}
              className="btn-ghost text-xs"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn-primary text-xs"
            >
              Save Schedule
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
