import React, { useEffect, useState, useCallback } from 'react';
import { Plus, XCircle, Trash2, RefreshCw, Layers, Zap, Copy, Play, CheckCircle2, Clock, Activity, ArrowUpRight } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';

export const BatchManager = ({ onViewJob }) => {
  const { currentProject } = useProject();
  const { lastEvent } = useWebSocket();
  const [batches, setBatches] = useState([]);
  const [selectedBatch, setSelectedBatch] = useState(null);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [isBurstModalOpen, setIsBurstModalOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSubmittingBurst, setIsSubmittingBurst] = useState(false);

  // Standard Batch State
  const [batchName, setBatchName] = useState('');
  const [jobItems, setJobItems] = useState([
    {
      name: 'Batch Item 1',
      jobType: 'http_request',
      payload: '{\n  "url": "https://httpbin.org/get",\n  "method": "GET"\n}',
      priority: 10
    },
    {
      name: 'Batch Item 2',
      jobType: 'cpu_compute',
      payload: '{\n  "type": "hash_iterations",\n  "algorithm": "sha256",\n  "iterations": 100000\n}',
      priority: 10
    }
  ]);
  const [formError, setFormError] = useState(null);

  // Burst State
  const [burstName, setBurstName] = useState('High-Volume Job Burst');
  const [burstJobType, setBurstJobType] = useState('cpu_compute');
  const [burstPayload, setBurstPayload] = useState('{\n  "type": "hash_iterations",\n  "algorithm": "sha256",\n  "iterations": 50000\n}');
  const [burstCount, setBurstCount] = useState(100);
  const [burstPriority, setBurstPriority] = useState(10);
  const [burstError, setBurstError] = useState(null);

  const fetchBatches = useCallback(async () => {
    if (!currentProject) return;
    try {
      setIsRefreshing(true);
      const bRes = await api.batches.list(currentProject.id);
      setBatches(bRes?.data || []);
    } catch (err) {
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [currentProject?.id]);

  useEffect(() => {
    fetchBatches();
    const interval = setInterval(fetchBatches, 3000);
    return () => clearInterval(interval);
  }, [fetchBatches]);

  useEffect(() => {
    if (lastEvent && (lastEvent.type?.startsWith('BATCH_') || lastEvent.type?.startsWith('JOB_'))) {
      fetchBatches();
    }
  }, [lastEvent, fetchBatches]);

  const handleOpenBatchDetails = async (batchId) => {
    try {
      const res = await api.batches.getById(batchId);
      setSelectedBatch(res.data);
    } catch (err) {}
  };

  const handleAddJobItem = () => {
    setJobItems([
      ...jobItems,
      {
        name: `Batch Item ${jobItems.length + 1}`,
        jobType: 'http_request',
        payload: '{\n  "url": "https://httpbin.org/get",\n  "method": "GET"\n}',
        priority: 10
      }
    ]);
  };

  const handleRemoveJobItem = (index) => {
    setJobItems(jobItems.filter((_, i) => i !== index));
  };

  const handleUpdateJobItem = (index, field, value) => {
    const updated = [...jobItems];
    updated[index][field] = value;
    setJobItems(updated);
  };

  const handleCreateBatch = async (e) => {
    e.preventDefault();
    setFormError(null);

    try {
      const formattedJobs = jobItems.map((item) => ({
        name: item.name,
        jobType: item.jobType,
        payload: JSON.parse(item.payload),
        priority: parseInt(item.priority || '10', 10),
        timeoutSeconds: 60,
        maxRetries: 3
      }));

      await api.batches.create({
        projectId: currentProject.id,
        name: batchName || 'Custom Multi-Job Pipeline',
        jobs: formattedJobs
      });

      setIsCreateModalOpen(false);
      setBatchName('');
      fetchBatches();
    } catch (err) {
      setFormError(err.message || 'Failed to submit batch');
    }
  };

  const handleCreateBurstBatch = async (e) => {
    e.preventDefault();
    setBurstError(null);

    const countNum = parseInt(burstCount, 10);
    if (!countNum || countNum < 1) {
      setBurstError('Please specify at least 1 job copy');
      return;
    }

    try {
      setIsSubmittingBurst(true);
      let parsedPayload = {};
      try {
        parsedPayload = JSON.parse(burstPayload);
      } catch (pe) {
        throw new Error(`Invalid JSON Payload: ${pe.message}`);
      }

      await api.batches.create({
        projectId: currentProject.id,
        name: burstName || `Burst ${countNum.toLocaleString()}x - ${burstJobType}`,
        templateJob: {
          name: burstName || 'Burst Job',
          jobType: burstJobType,
          payload: parsedPayload,
          priority: parseInt(burstPriority, 10) || 10,
          timeoutSeconds: 60,
          maxRetries: 3
        },
        count: countNum
      });

      setIsBurstModalOpen(false);
      fetchBatches();
    } catch (err) {
      setBurstError(err.message || 'Failed to dispatch high-volume batch');
    } finally {
      setIsSubmittingBurst(false);
    }
  };

  const handleCancelBatch = async (batchId) => {
    try {
      await api.batches.cancel(batchId);
      fetchBatches();
      if (selectedBatch?.id === batchId) {
        handleOpenBatchDetails(batchId);
      }
    } catch (err) {}
  };

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Batch Pipelines &amp; Workload Bursts</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Atomic batch ingestion, high-concurrency burst workloads &amp; real-time progress aggregation
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchBatches}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Batch List"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setIsBurstModalOpen(true)}
            className="btn-secondary text-xs gap-1.5 border-amber-500/30 text-amber-300 hover:border-amber-500/50 hover:bg-amber-500/10"
          >
            <Zap className="w-4 h-4 text-amber-400" />
            <span>Burst Workload</span>
          </button>
          <button
            onClick={() => setIsCreateModalOpen(true)}
            className="btn-primary text-xs"
          >
            <Plus className="w-4 h-4" />
            <span>New Custom Batch</span>
          </button>
        </div>
      </div>

      {/* Batch Cards Grid */}
      {loading ? (
        <div className="glass-card p-12 text-center text-xs text-slate-500">
          <RefreshCw className="w-5 h-5 animate-spin mx-auto text-indigo-400 mb-2" />
          <span>Loading project batches...</span>
        </div>
      ) : batches.length === 0 ? (
        <div className="glass-card p-12 text-center space-y-4">
          <Layers className="w-10 h-10 text-slate-600 mx-auto" />
          <div>
            <h3 className="text-base font-bold text-slate-200">No Batches in Current Project</h3>
            <p className="text-xs text-slate-400 max-w-md mx-auto mt-1">
              Dispatch high-volume bursts or custom pipelines to verify atomic queue sharding and worker claiming.
            </p>
          </div>
          <div className="flex items-center justify-center gap-3 pt-2">
            <button
              onClick={() => setIsBurstModalOpen(true)}
              className="btn-secondary text-xs border-amber-500/30 text-amber-300"
            >
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span>Send 100x / 500x Burst</span>
            </button>
            <button
              onClick={() => setIsCreateModalOpen(true)}
              className="btn-primary text-xs"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>Create Custom Batch</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {batches.map((batch) => {
            const completedRatio =
              batch.total_jobs > 0
                ? Math.min(100, Math.round((Number(batch.completed_jobs) / Number(batch.total_jobs)) * 100))
                : 0;
            const isFullyCompleted = Number(batch.completed_jobs) === Number(batch.total_jobs) && Number(batch.total_jobs) > 0;

            return (
              <div
                key={batch.id}
                onClick={() => handleOpenBatchDetails(batch.id)}
                className="glass-card p-5 space-y-3.5 cursor-pointer"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-base font-bold text-white truncate max-w-[240px]">{batch.name}</h3>
                    <p className="text-[11px] font-mono text-slate-500 mt-0.5">{batch.id}</p>
                  </div>
                  <Badge status={batch.status} />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-slate-400 font-medium">
                    <span className={isFullyCompleted ? 'text-emerald-400 font-bold' : ''}>
                      {completedRatio}% processed
                    </span>
                    <span className="font-mono text-slate-300">{batch.completed_jobs} / {batch.total_jobs} jobs</span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${completedRatio}%`,
                        background: isFullyCompleted ? '#10b981' : '#6366f1'
                      }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-4 gap-2 rounded-xl bg-slate-950/60 border border-slate-800/80 p-2.5 text-center text-xs">
                  <div>
                    <span className="text-[10px] uppercase font-semibold text-slate-500 block">Total</span>
                    <span className="font-bold text-slate-200 mt-0.5 block">{batch.total_jobs}</span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase font-semibold text-slate-500 block">Pending</span>
                    <span className="font-bold text-amber-400 mt-0.5 block">{batch.pending_jobs}</span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase font-semibold text-slate-500 block">Done</span>
                    <span className="font-bold text-emerald-400 mt-0.5 block">{batch.completed_jobs}</span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase font-semibold text-slate-500 block">Failed</span>
                    <span className="font-bold text-rose-400 mt-0.5 block">{batch.failed_jobs}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-800/80">
                  <span>Created: {new Date(batch.created_at).toLocaleTimeString()}</span>
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {batch.status !== 'completed' && batch.status !== 'failed' && (
                      <button
                        onClick={() => handleCancelBatch(batch.id)}
                        className="btn-danger text-[11px] py-1 px-2"
                      >
                        Cancel Batch
                      </button>
                    )}
                    <button
                      onClick={() => handleOpenBatchDetails(batch.id)}
                      className="btn-ghost text-[11px] py-1 px-2 gap-1 text-indigo-400 hover:text-indigo-300"
                    >
                      <span>Inspect</span>
                      <ArrowUpRight className="w-3 h-3" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Batch Details Modal */}
      {selectedBatch && (
        <Modal
          isOpen={!!selectedBatch}
          onClose={() => setSelectedBatch(null)}
          title={`Batch Audit: ${selectedBatch.name}`}
          maxWidth="max-w-4xl"
        >
          <div className="space-y-4 text-xs">
            <div className="flex items-center justify-between border-b border-slate-800 pb-3">
              <div className="flex items-center gap-2">
                <Badge status={selectedBatch.status} />
                <span className="font-mono text-slate-400">{selectedBatch.id}</span>
              </div>
              <div className="text-right font-mono text-slate-300">
                <span className="text-emerald-400 font-bold">{selectedBatch.completed_jobs || 0}</span> / {selectedBatch.total_jobs || 0} completed
              </div>
            </div>

            <div className="space-y-2 max-h-80 overflow-y-auto pr-1">
              {(!selectedBatch.jobs || selectedBatch.jobs.length === 0) ? (
                <div className="p-8 text-center text-slate-500 italic">No job items in this batch record.</div>
              ) : (
                selectedBatch.jobs.map((job) => (
                  <div
                    key={job.id}
                    onClick={() => onViewJob?.(job.id)}
                    className="flex items-center justify-between p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 cursor-pointer hover:bg-slate-800/40 transition-all"
                  >
                    <div className="flex items-center gap-2.5">
                      <Badge status={job.status} />
                      <div>
                        <p className="font-semibold text-slate-200">{job.name}</p>
                        <p className="text-[10px] text-slate-500 font-mono">
                          {job.job_type} · Priority {job.priority} · Shard #{job.shard_index ?? 0}
                        </p>
                      </div>
                    </div>
                    <div className="text-right text-[11px] font-mono text-slate-400">
                      {job.worker_id && <p className="text-emerald-400">⚡ {job.worker_id}</p>}
                      <p>{new Date(job.updated_at).toLocaleTimeString()}</p>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </Modal>
      )}

      {/* Burst Modal */}
      <Modal isOpen={isBurstModalOpen} onClose={() => setIsBurstModalOpen(false)} title="Dispatch High-Volume Burst Jobs" maxWidth="max-w-xl">
        <form onSubmit={handleCreateBurstBatch} className="space-y-4 text-xs">
          {burstError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
              {burstError}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Burst Campaign Title</label>
            <input
              type="text"
              required
              value={burstName}
              onChange={(e) => setBurstName(e.target.value)}
              className="djs-input"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">Number of Identical Jobs</label>
              <input
                type="number"
                min="1"
                max="10000"
                value={burstCount}
                onChange={(e) => setBurstCount(e.target.value)}
                className="djs-input"
              />
            </div>

            <div>
              <label className="block font-semibold text-slate-300 mb-1.5">Execution Service</label>
              <select
                value={burstJobType}
                onChange={(e) => setBurstJobType(e.target.value)}
                className="djs-select"
              >
                <option value="cpu_compute">CPU Compute Workload</option>
                <option value="http_request">HTTP Webhook Request</option>
                <option value="db_query">Database Batch Insert</option>
                <option value="notification_event">Notification Dispatcher</option>
                <option value="custom_script">Custom Script</option>
              </select>
            </div>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Job Payload Template (JSON)</label>
            <textarea
              rows={4}
              value={burstPayload}
              onChange={(e) => setBurstPayload(e.target.value)}
              className="djs-textarea"
            />
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" onClick={() => setIsBurstModalOpen(false)} className="btn-ghost text-xs">
              Cancel
            </button>
            <button type="submit" disabled={isSubmittingBurst} className="btn-primary text-xs">
              <Zap className="w-4 h-4" />
              <span>{isSubmittingBurst ? 'Spawning Burst Jobs...' : `Dispatch ${parseInt(burstCount || '1', 10).toLocaleString()} Jobs`}</span>
            </button>
          </div>
        </form>
      </Modal>

      {/* Custom Batch Modal */}
      <Modal isOpen={isCreateModalOpen} onClose={() => setIsCreateModalOpen(false)} title="Create Multi-Job Pipeline" maxWidth="max-w-2xl">
        <form onSubmit={handleCreateBatch} className="space-y-4 text-xs">
          {formError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
              {formError}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Pipeline Name</label>
            <input
              type="text"
              required
              placeholder="e.g. End of Day Reconciliation Pipeline"
              value={batchName}
              onChange={(e) => setBatchName(e.target.value)}
              className="djs-input"
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-slate-300">Pipeline Jobs ({jobItems.length})</span>
              <button
                type="button"
                onClick={handleAddJobItem}
                className="btn-secondary text-xs py-1 px-2.5 gap-1"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Add Job Item</span>
              </button>
            </div>

            <div className="space-y-3 max-h-60 overflow-y-auto pr-1">
              {jobItems.map((item, idx) => (
                <div key={idx} className="p-3.5 rounded-xl bg-slate-950/70 border border-slate-800/80 space-y-2.5">
                  <div className="flex items-center justify-between gap-2">
                    <input
                      type="text"
                      value={item.name}
                      onChange={(e) => handleUpdateJobItem(idx, 'name', e.target.value)}
                      placeholder={`Job #${idx + 1}`}
                      className="djs-input py-1 text-xs font-medium"
                    />
                    <select
                      value={item.jobType}
                      onChange={(e) => handleUpdateJobItem(idx, 'jobType', e.target.value)}
                      className="djs-select py-1 text-xs w-44"
                    >
                      <option value="http_request">HTTP Webhook</option>
                      <option value="db_query">Database Query</option>
                      <option value="cpu_compute">CPU Compute</option>
                      <option value="notification_event">Notification</option>
                      <option value="custom_script">Custom Script</option>
                    </select>
                    {jobItems.length > 1 && (
                      <button
                        type="button"
                        onClick={() => handleRemoveJobItem(idx)}
                        className="p-1 text-slate-500 hover:text-rose-400 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                  <textarea
                    rows={2}
                    value={item.payload}
                    onChange={(e) => handleUpdateJobItem(idx, 'payload', e.target.value)}
                    className="djs-textarea text-[11px]"
                  />
                </div>
              ))}
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" onClick={() => setIsCreateModalOpen(false)} className="btn-ghost text-xs">
              Cancel
            </button>
            <button type="submit" className="btn-primary text-xs">
              Create Pipeline Batch
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
