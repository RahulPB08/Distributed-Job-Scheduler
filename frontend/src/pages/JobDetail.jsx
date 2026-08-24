import React, { useEffect, useState, useCallback } from 'react';
import { RotateCw, XCircle, Terminal, Server, Clock, ShieldCheck, Layers, AlertCircle, CheckCircle2, Copy, Check } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { Badge } from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';

export const JobDetailModal = ({ jobId, isOpen, onClose, onJobUpdated }) => {
  const [job, setJob] = useState(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState(false);
  const [copiedPayload, setCopiedPayload] = useState(false);

  const fetchJobDetails = useCallback(async (showLoading = false) => {
    if (!jobId) return;
    if (showLoading) setLoading(true);
    try {
      const res = await api.jobs.getById(jobId);
      setJob(res?.data || null);
    } catch (err) {
      setJob(null);
    } finally {
      if (showLoading) setLoading(false);
    }
  }, [jobId]);

  useEffect(() => {
    if (isOpen && jobId) {
      fetchJobDetails(true);
      const interval = setInterval(() => fetchJobDetails(false), 2000);
      return () => clearInterval(interval);
    } else {
      setJob(null);
      setLoading(false);
    }
  }, [isOpen, jobId, fetchJobDetails]);

  const handleRetry = async () => {
    setActionLoading(true);
    try {
      await api.jobs.retry(jobId);
      await fetchJobDetails(false);
      onJobUpdated?.();
    } catch (e) {
    } finally {
      setActionLoading(false);
    }
  };

  const handleCancel = async () => {
    setActionLoading(true);
    try {
      await api.jobs.cancel(jobId);
      await fetchJobDetails(false);
      onJobUpdated?.();
    } catch (e) {
    } finally {
      setActionLoading(false);
    }
  };

  const handleCopy = (text) => {
    navigator.clipboard.writeText(typeof text === 'string' ? text : JSON.stringify(text, null, 2));
    setCopiedPayload(true);
    setTimeout(() => setCopiedPayload(false), 2000);
  };

  if (!isOpen) return null;

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={`Job Audit: ${job?.name || jobId}`} maxWidth="max-w-4xl">
      {loading ? (
        <div className="py-16 text-center text-xs text-slate-500 font-mono flex items-center justify-center gap-2">
          <RotateCw className="w-4 h-4 animate-spin text-indigo-400" />
          <span>Fetching execution metadata and logs...</span>
        </div>
      ) : !job ? (
        <div className="py-12 text-center text-xs text-rose-400">Job record not found.</div>
      ) : (
        <div className="space-y-4 text-xs">
          {/* Header Action Bar */}
          <div className="flex flex-wrap items-center justify-between gap-3 pb-3 border-b border-slate-800">
            <div className="flex flex-wrap items-center gap-2">
              <Badge status={job.status} />
              <Badge status={job.job_type} />
              <span className="text-slate-300 font-semibold px-2.5 py-1 rounded-lg bg-slate-900 border border-slate-800 font-mono">
                Queue: {job.queue_name || 'default'}
              </span>
              <span className="text-[11px] bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 px-2 py-0.5 rounded-full font-mono font-medium">
                Partition: Shard #{job.shard_index ?? 0}
              </span>
            </div>

            <div className="flex items-center gap-2">
              {['failed', 'dlq'].includes(job.status) && (
                <button
                  onClick={handleRetry}
                  disabled={actionLoading}
                  className="btn-primary text-xs py-1.5 px-3"
                >
                  <RotateCw className={`w-3.5 h-3.5 ${actionLoading ? 'animate-spin' : ''}`} />
                  <span>Retry Execution</span>
                </button>
              )}
              {['scheduled', 'queued', 'running', 'claimed'].includes(job.status) && (
                <button
                  onClick={handleCancel}
                  disabled={actionLoading}
                  className="btn-danger text-xs py-1.5 px-3"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  <span>Cancel Job</span>
                </button>
              )}
            </div>
          </div>

          {/* Metadata Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 p-4 rounded-2xl bg-slate-950/80 border border-slate-800/80">
            <div className="space-y-1">
              <span className="text-slate-400 block text-[11px] font-medium flex items-center gap-1.5">
                <Server className="w-3.5 h-3.5 text-emerald-400" />
                Executing Worker
              </span>
              <p className="font-semibold text-emerald-400 font-mono text-xs truncate" title={job.worker_id}>
                {job.worker_id ? `⚡ ${job.worker_id}` : 'Pending claim...'}
              </p>
              {job.worker_hostname && (
                <span className="text-[10px] text-slate-500 block truncate">Host: {job.worker_hostname}</span>
              )}
            </div>

            <div className="space-y-1">
              <span className="text-slate-400 block text-[11px] font-medium flex items-center gap-1.5">
                <Clock className="w-3.5 h-3.5 text-indigo-400" />
                Scheduler
              </span>
              <p className="font-semibold text-indigo-300 font-mono text-xs truncate">
                Single Authoritative
              </p>
              <span className="text-[10px] text-slate-500 block">Priority + Aging Fair Queue</span>
            </div>

            <div className="space-y-1">
              <span className="text-slate-400 block text-[11px] font-medium flex items-center gap-1.5">
                <Layers className="w-3.5 h-3.5 text-cyan-400" />
                Queue Partition
              </span>
              <p className="font-semibold text-cyan-300 font-mono text-xs">
                Shard #{job.shard_index ?? 0}
              </p>
              <span className="text-[10px] text-slate-500 block truncate">{job.queue_name || 'default'}</span>
            </div>

            <div className="space-y-1">
              <span className="text-slate-400 block text-[11px] font-medium flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-amber-400" />
                Retries / Priority
              </span>
              <p className="font-semibold text-slate-200 text-xs font-mono">
                {job.retry_count}/{job.max_retries} <span className="text-indigo-400">(P{job.priority})</span>
              </p>
              <span className="text-[10px] text-slate-500 block">
                {job.scheduled_at ? `At: ${new Date(job.scheduled_at).toLocaleTimeString()}` : 'Immediate'}
              </span>
            </div>
          </div>

          {/* Execution History */}
          <div className="space-y-2">
            <h4 className="font-semibold text-slate-200 flex items-center gap-2">
              <Clock className="w-4 h-4 text-indigo-400" />
              <span>Execution Attempts ({job.executions?.length || 0})</span>
            </h4>
            <div className="space-y-2 max-h-48 overflow-y-auto">
              {!job.executions || job.executions.length === 0 ? (
                <div className="text-slate-500 italic p-3 border border-slate-800 rounded-xl bg-slate-950/60 text-center">
                  Waiting for worker to claim and execute...
                </div>
              ) : (
                job.executions.map((exec) => (
                  <div
                    key={exec.id}
                    className="flex items-center justify-between rounded-xl border border-slate-800/80 bg-slate-950/60 p-3"
                  >
                    <div className="flex items-center gap-2.5">
                      <Badge status={exec.status} />
                      <span className="font-semibold text-slate-200">Attempt #{exec.attempt_number}</span>
                      <span className="text-slate-400 font-mono text-[11px]">Worker: {exec.worker_id}</span>
                      <span className="text-[10px] bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 px-1.5 py-0.5 rounded font-mono">
                        Shard #{job.shard_index ?? 0}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-slate-400 font-mono text-[11px]">
                      <span className="text-slate-300 font-bold">{exec.duration_ms !== null ? `${exec.duration_ms}ms` : 'running...'}</span>
                      <span>{new Date(exec.started_at).toLocaleTimeString()}</span>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

          {/* Payload & Result */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <h4 className="font-semibold text-slate-300">Input Payload</h4>
                <button
                  onClick={() => handleCopy(job.payload)}
                  className="text-slate-400 hover:text-white flex items-center gap-1 text-[11px]"
                >
                  {copiedPayload ? <Check className="w-3 h-3 text-emerald-400" /> : <Copy className="w-3 h-3" />}
                  <span>{copiedPayload ? 'Copied' : 'Copy'}</span>
                </button>
              </div>
              <pre className="h-40 overflow-auto rounded-xl border border-slate-800/80 bg-slate-950 p-3 font-mono text-[11px] text-slate-300">
                {JSON.stringify(job.payload, null, 2)}
              </pre>
            </div>

            <div className="space-y-1.5">
              <h4 className="font-semibold text-slate-300">Execution Output / Diagnostic</h4>
              <pre className={`h-40 overflow-auto rounded-xl border p-3 font-mono text-[11px] ${
                job.error_details
                  ? 'border-rose-800/60 bg-rose-950/20 text-rose-300'
                  : 'border-slate-800/80 bg-slate-950 text-slate-300'
              }`}>
                {job.result ? JSON.stringify(job.result, null, 2) : job.error_details ? (typeof job.error_details === 'string' ? job.error_details : JSON.stringify(job.error_details, null, 2)) : 'No output recorded yet (job queued or executing).'}
              </pre>
            </div>
          </div>

          {/* Execution Step Logs */}
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-emerald-400" />
                <h4 className="font-semibold text-slate-200">Execution Step Telemetry</h4>
              </div>
              <span className="text-[11px] text-slate-500 font-mono">{job.logs?.length || 0} events recorded</span>
            </div>
            <div className="max-h-44 overflow-auto rounded-xl border border-slate-800/80 bg-slate-950 p-3 font-mono text-[11px] space-y-1.5">
              {!job.logs || job.logs.length === 0 ? (
                <div className="text-slate-500 italic">No execution logs captured yet.</div>
              ) : (
                job.logs.map((log) => (
                  <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                    <span className="text-slate-500 shrink-0">
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </span>
                    <span className={`font-semibold uppercase text-[10px] px-1 rounded shrink-0 ${
                      log.log_level === 'error'
                        ? 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
                        : log.log_level === 'warn'
                        ? 'bg-amber-500/15 text-amber-400 border border-amber-500/30'
                        : 'bg-indigo-500/15 text-indigo-400 border border-indigo-500/30'
                    }`}>
                      {log.log_level}
                    </span>
                    <span className={log.log_level === 'error' ? 'text-rose-300' : 'text-slate-300'}>
                      {log.message}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
