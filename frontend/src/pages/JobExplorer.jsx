import React, { useEffect, useState, useCallback } from 'react';
import { Plus, Search, RefreshCw, RotateCw, XCircle, Play, Filter, ArrowUpRight, Clock, Server, Layers } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from '../components/Badge.jsx';
import { JobDetailModal } from './JobDetail.jsx';
import { CreateJobModal } from '../components/CreateJobModal.jsx';

export const JobExplorer = ({ initialSelectedJobId, onClearSelectedJob }) => {
  const { currentProject } = useProject();
  const { lastEvent } = useWebSocket();
  const [jobs, setJobs] = useState([]);
  const [queues, setQueues] = useState([]);
  const [statusFilter, setStatusFilter] = useState('');
  const [queueFilter, setQueueFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedJobId, setSelectedJobId] = useState(initialSelectedJobId || null);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchJobs = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    setIsRefreshing(true);
    try {
      const [jobsRes, queuesRes] = await Promise.all([
        api.jobs.list({
          projectId: currentProject?.id || undefined,
          status: statusFilter || undefined,
          queueId: queueFilter || undefined,
          page,
          limit: 15
        }),
        api.queues.list(currentProject?.id || undefined)
      ]);

      const extractedJobs = jobsRes?.data?.jobs || (Array.isArray(jobsRes?.data) ? jobsRes.data : []);
      const extractedPages = jobsRes?.data?.totalPages || 1;
      const extractedQueues = Array.isArray(queuesRes?.data) ? queuesRes.data : (queuesRes?.data?.queues || []);

      setJobs(extractedJobs);
      setTotalPages(extractedPages);
      setQueues(extractedQueues);
    } catch (err) {
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [currentProject?.id, statusFilter, queueFilter, page]);

  useEffect(() => {
    fetchJobs(true);
  }, [fetchJobs]);

  useEffect(() => {
    if (lastEvent && (lastEvent.type?.startsWith('JOB_') || lastEvent.type?.startsWith('QUEUE_') || lastEvent.type?.startsWith('BATCH_') || lastEvent.type?.startsWith('WORKER_'))) {
      fetchJobs(false);
    }
  }, [lastEvent, fetchJobs]);

  useEffect(() => {
    if (initialSelectedJobId) {
      setSelectedJobId(initialSelectedJobId);
      setIsDetailOpen(true);
    }
  }, [initialSelectedJobId]);

  const handleRowClick = (jobId) => {
    setSelectedJobId(jobId);
    setIsDetailOpen(true);
  };

  const handleCloseDetail = () => {
    setIsDetailOpen(false);
    setSelectedJobId(null);
    onClearSelectedJob?.();
  };

  const handleRetry = async (e, jobId) => {
    e.stopPropagation();
    try {
      await api.jobs.retry(jobId);
      fetchJobs(false);
    } catch (err) {}
  };

  const handleCancel = async (e, jobId) => {
    e.stopPropagation();
    try {
      await api.jobs.cancel(jobId);
      fetchJobs(false);
    } catch (err) {}
  };

  const filteredJobs = jobs.filter((j) =>
    (j.name || '').toLowerCase().includes(searchQuery.toLowerCase()) ||
    (j.id || '').toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Play className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Job Explorer</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Live lifecycle monitoring, atomic claiming audit, retry tracking &amp; log inspection
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => fetchJobs(true)}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setIsCreateOpen(true)}
            className="btn-primary text-xs"
          >
            <Plus className="w-4 h-4" />
            <span>Dispatch Job</span>
          </button>
        </div>
      </div>

      {/* Filter Toolbar */}
      <div className="flex flex-wrap items-center gap-3 glass-card p-3">
        <div className="relative flex-1 min-w-[220px]">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            placeholder="Search by job name or UUID..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="djs-input pl-10 text-xs py-2"
          />
        </div>

        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-slate-500 shrink-0" />
          <select
            value={statusFilter}
            onChange={(e) => {
              setStatusFilter(e.target.value);
              setPage(1);
            }}
            className="djs-select text-xs py-2 w-36"
          >
            <option value="">All Statuses</option>
            <option value="scheduled">Scheduled</option>
            <option value="queued">Queued</option>
            <option value="claimed">Claimed</option>
            <option value="running">Running</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
            <option value="dlq">DLQ</option>
            <option value="cancelled">Cancelled</option>
          </select>

          <select
            value={queueFilter}
            onChange={(e) => {
              setQueueFilter(e.target.value);
              setPage(1);
            }}
            className="djs-select text-xs py-2 w-44"
          >
            <option value="">All Service Queues</option>
            {queues.map((q) => (
              <option key={q.id} value={q.id}>
                {q.name}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Job Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="djs-table">
            <thead>
              <tr>
                <th>Job Name / ID</th>
                <th>Service &amp; Partition</th>
                <th>Worker Node</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Scheduled Time</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="7" className="py-12 text-center text-slate-500">
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      <span>Loading job lifecycle records...</span>
                    </div>
                  </td>
                </tr>
              ) : filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan="7" className="py-12 text-center text-slate-500">
                    No jobs found matching your criteria. Dispatch a job above to test execution!
                  </td>
                </tr>
              ) : (
                filteredJobs.map((job) => (
                  <tr
                    key={job.id}
                    onClick={() => handleRowClick(job.id)}
                    className="cursor-pointer transition-all hover:bg-slate-800/40"
                  >
                    <td>
                      <div className="font-semibold text-slate-100">{job.name}</div>
                      <div className="text-[10px] font-mono text-slate-500 mt-0.5">{job.id}</div>
                    </td>
                    <td>
                      <div className="text-slate-200 font-medium">{job.queue_name || 'default'}</div>
                      <div className="flex items-center gap-1.5 mt-1">
                        <span className="text-[10px] bg-cyan-500/10 text-cyan-300 border border-cyan-500/20 px-1.5 py-0.5 rounded font-mono">
                          Shard #{job.shard_index ?? 0}
                        </span>
                        <Badge status={job.job_type} />
                      </div>
                    </td>
                    <td className="font-mono text-xs">
                      {job.worker_id ? (
                        <span className="text-emerald-400 font-semibold flex items-center gap-1">
                          <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                          <span className="truncate max-w-[130px]" title={job.worker_id}>{job.worker_id}</span>
                        </span>
                      ) : (
                        <span className="text-slate-500 italic text-[11px]">Unassigned (queued)</span>
                      )}
                    </td>
                    <td>
                      <span className="font-mono font-bold text-slate-300 px-2 py-0.5 rounded bg-slate-800 border border-slate-700 text-xs">
                        P{job.priority}
                      </span>
                    </td>
                    <td>
                      <Badge status={job.status} />
                    </td>
                    <td className="font-mono text-slate-400 text-xs">
                      {job.scheduled_at ? new Date(job.scheduled_at).toLocaleTimeString() : 'Immediate'}
                    </td>
                    <td className="text-right" onClick={(e) => e.stopPropagation()}>
                      <div className="flex items-center justify-end gap-1.5">
                        {['failed', 'dlq'].includes(job.status) && (
                          <button
                            onClick={(e) => handleRetry(e, job.id)}
                            title="Retry Execution"
                            className="p-1.5 rounded-lg text-indigo-400 hover:bg-indigo-500/10 border border-transparent hover:border-indigo-500/20 transition-all"
                          >
                            <RotateCw className="w-4 h-4" />
                          </button>
                        )}
                        {['scheduled', 'queued', 'running', 'claimed'].includes(job.status) && (
                          <button
                            onClick={(e) => handleCancel(e, job.id)}
                            title="Cancel Job"
                            className="p-1.5 rounded-lg text-rose-400 hover:bg-rose-500/10 border border-transparent hover:border-rose-500/20 transition-all"
                          >
                            <XCircle className="w-4 h-4" />
                          </button>
                        )}
                        <button
                          onClick={() => handleRowClick(job.id)}
                          title="Inspect Details"
                          className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
                        >
                          <ArrowUpRight className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalPages > 1 && (
          <div className="flex items-center justify-between border-t border-slate-800/80 px-4 py-3 text-xs text-slate-400">
            <span>Page {page} of {totalPages}</span>
            <div className="flex gap-2">
              <button
                disabled={page <= 1}
                onClick={() => setPage(page - 1)}
                className="btn-secondary text-xs py-1 px-3 disabled:opacity-40"
              >
                Previous
              </button>
              <button
                disabled={page >= totalPages}
                onClick={() => setPage(page + 1)}
                className="btn-secondary text-xs py-1 px-3 disabled:opacity-40"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </div>

      <JobDetailModal
        jobId={selectedJobId}
        isOpen={isDetailOpen}
        onClose={handleCloseDetail}
        onJobUpdated={() => fetchJobs(false)}
      />

      <CreateJobModal
        isOpen={isCreateOpen}
        onClose={() => setIsCreateOpen(false)}
        onJobCreated={() => fetchJobs(false)}
      />
    </div>
  );
};
