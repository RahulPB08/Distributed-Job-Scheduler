import React, { useEffect, useState, useCallback } from 'react';
import {
  Layers, RefreshCw, AlertCircle, CheckCircle, XCircle, Shield,
  Activity, Server, Gauge, Zap, Cpu, ArrowUpRight, TrendingUp, TrendingDown,
  Lock, Box, Clock, Pause, Play, Trash2
} from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from '../components/Badge.jsx';

export const QueueManager = () => {
  const { currentProject, projects } = useProject();
  const { lastEvent } = useWebSocket();
  const [queues, setQueues] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [actionLoading, setActionLoading] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const [snatcherStats, setSnatcherStats] = useState(null);

  const effectiveProjectId = currentProject?.id || (projects && projects.length > 0 ? projects[0].id : null);

  const fetchQueues = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const [qRes, aRes] = await Promise.all([
        api.queues.list(effectiveProjectId || undefined),
        api.metrics.getAutoscaler().catch(() => null)
      ]);
      setQueues(qRes?.data || []);
      if (aRes?.data?.shardSnatcher) {
        setSnatcherStats(aRes.data.shardSnatcher);
      }
    } catch (err) {
      console.error('Failed to fetch queues:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [effectiveProjectId]);

  useEffect(() => {
    fetchQueues();
    const interval = setInterval(fetchQueues, 3000);
    return () => clearInterval(interval);
  }, [fetchQueues]);

  useEffect(() => {
    if (lastEvent && (lastEvent.type?.includes('QUEUE') || lastEvent.type?.includes('JOB') || lastEvent.type?.includes('AUTOSCALE') || lastEvent.type?.includes('SNATCH'))) {
      fetchQueues();
    }
  }, [lastEvent, fetchQueues]);

  const handlePauseResume = async (queue) => {
    setActionLoading(queue.id);
    try {
      if (queue.is_paused) {
        await api.queues.resume(queue.id);
        showToast(`Queue [${queue.name}] resumed`);
      } else {
        await api.queues.pause(queue.id);
        showToast(`Queue [${queue.name}] paused`);
      }
      fetchQueues();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const handlePurge = async (queue) => {
    if (!window.confirm(`Purge all queued jobs from [${queue.name}]? This action cannot be undone.`)) return;
    setActionLoading(queue.id);
    try {
      await api.queues.purge(queue.id);
      showToast(`Queue [${queue.name}] backlog purged`);
      fetchQueues();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setActionLoading(null);
    }
  };

  const totalQueues = queues.length;
  const totalShards = queues.reduce((sum, q) => sum + (q.shard_count || q.shardCount || q.shards?.length || 2), 0);
  const totalQueuedBacklog = queues.reduce((sum, q) => sum + (q.live_depth ?? q.depth ?? 0), 0);
  const totalRunning = queues.reduce((sum, q) => sum + (q.running_count ?? q.runningCount ?? 0), 0);

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Toast Notification */}
      {toast && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-3 rounded-xl shadow-2xl border text-xs font-semibold animate-slide-in ${
            toast.type === 'error'
              ? 'bg-rose-950/90 border-rose-800 text-rose-200'
              : 'bg-emerald-950/90 border-emerald-800 text-emerald-200'
          }`}
        >
          {toast.type === 'error' ? <AlertCircle className="w-4 h-4" /> : <CheckCircle className="w-4 h-4" />}
          <span>{toast.msg}</span>
        </div>
      )}

      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-blue-500/10 border border-blue-500/20 text-blue-400">
            <Layers className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">System-Automated Service Queues</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Dedicated 1-queue-per-service architecture with 2 baseline shards &amp; dynamic load scaling
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span>Autonomous Sharding Active</span>
          </div>
          <button
            onClick={() => fetchQueues()}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Queues"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Autonomous Queue & Shard Work-Stealing Banner */}
      <div className="glass-card p-5 border-cyan-500/30 bg-gradient-to-r from-cyan-950/20 via-slate-900/50 to-indigo-950/20 space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 pb-2.5 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-cyan-500/20 text-cyan-300">
              <Zap className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">Autonomous Queue &amp; Shard Job Snatching (Work-Stealing)</h3>
              <p className="text-xs text-slate-400">Idle shards and other queues automatically snatch jobs from busy overloaded queues</p>
            </div>
          </div>
          <span className="px-3 py-1 rounded-full text-xs font-mono font-bold bg-cyan-500/15 text-cyan-300 border border-cyan-500/30">
            {snatcherStats?.totalJobsSnatched || 0} Jobs Snatched &amp; Rebalanced
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs">
          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
            <div className="flex items-center justify-between font-semibold text-cyan-300">
              <span>⚡ Cross-Shard Snatching</span>
              <span className="font-mono text-white">{snatcherStats?.crossShardSnatches || 0} jobs</span>
            </div>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              When Shard #0 has a backlog spike, newly scaled or idle shards immediately snatch batches of waiting jobs to balance throughput.
            </p>
          </div>

          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800 space-y-1">
            <div className="flex items-center justify-between font-semibold text-indigo-300">
              <span>🔄 Cross-Queue Absorption</span>
              <span className="font-mono text-white">{snatcherStats?.crossQueueSnatches || 0} jobs</span>
            </div>
            <p className="text-slate-400 text-[11px] leading-relaxed">
              When one service queue is overwhelmed (e.g. 10,000 HTTP tasks), idle queues (DB, Compute, Script) snatch jobs so no worker or shard is idle.
            </p>
          </div>
        </div>
      </div>

      {/* Aggregate Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Automated Queues</span>
            <Server className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="text-2xl font-black text-white">{totalQueues}</p>
          <p className="text-[10px] text-slate-500">1 dedicated queue per service</p>
        </div>

        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Active Partitions</span>
            <Box className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-2xl font-black text-cyan-400">{totalShards}</p>
          <p className="text-[10px] text-slate-500">2 baseline shards per queue</p>
        </div>

        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Queued Backlog</span>
            <Clock className="w-4 h-4 text-amber-400" />
          </div>
          <p className="text-2xl font-black text-amber-400">{totalQueuedBacklog}</p>
          <p className="text-[10px] text-slate-500">Pending worker pickup</p>
        </div>

        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>In-Flight Processing</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-black text-emerald-400">{totalRunning}</p>
          <p className="text-[10px] text-slate-500">Active worker slot execution</p>
        </div>
      </div>

      {/* Queue Cards List */}
      {loading ? (
        <div className="glass-card p-12 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
          <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
          <span>Provisioning and loading dedicated service queues...</span>
        </div>
      ) : queues.length === 0 ? (
        <div className="glass-card p-12 text-center text-xs text-slate-500 space-y-3">
          <Layers className="w-10 h-10 text-slate-600 mx-auto" />
          <p className="font-semibold text-slate-300">Initializing Service Queues...</p>
          <p className="text-[11px] text-slate-500">Service queues are generated automatically for your active workspace.</p>
        </div>
      ) : (
        <div className="space-y-4">
          {queues.map((queue) => {
            const shards = queue.shards || [];
            const shardCount = shards.length || queue.shard_count || 2;
            const isScaledUp = shardCount > 2;

            return (
              <div
                key={queue.id}
                className="glass-card p-5 space-y-4"
              >
                {/* Queue Title & Controls Row */}
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800/80">
                  <div className="flex items-center gap-3">
                    <div className="px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-400 border border-indigo-500/20 font-mono text-xs font-bold">
                      PRIORITY {queue.priority}
                    </div>
                    <div>
                      <h3 className="text-base font-bold text-white flex items-center gap-2">
                        <span>{queue.name}</span>
                        {queue.is_paused ? (
                          <span className="badge badge-dead text-[10px]">PAUSED</span>
                        ) : isScaledUp ? (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 flex items-center gap-1 font-semibold">
                            <TrendingUp className="w-3 h-3" /> Auto-Scaled ({shardCount} Shards)
                          </span>
                        ) : (
                          <span className="text-[10px] px-2 py-0.5 rounded-full bg-slate-800 text-slate-400 border border-slate-700 font-semibold">
                            Baseline ({shardCount} Shards)
                          </span>
                        )}
                      </h3>
                      <p className="text-xs text-slate-400 mt-0.5">{queue.description || 'Dedicated system execution queue'}</p>
                    </div>
                  </div>

                  <div className="flex items-center gap-3">
                    <div className="text-right">
                      <div className="text-[10px] text-slate-400 uppercase font-semibold">Depth</div>
                      <div className="text-sm font-bold text-amber-400 font-mono">{queue.live_depth || 0} queued</div>
                    </div>
                    <div className="h-6 w-px bg-slate-800" />
                    <div className="text-right">
                      <div className="text-[10px] text-slate-400 uppercase font-semibold">Running</div>
                      <div className="text-sm font-bold text-emerald-400 font-mono">{queue.running_count || 0} active</div>
                    </div>
                    <div className="h-6 w-px bg-slate-800" />

                    {/* Queue Actions */}
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => handlePauseResume(queue)}
                        disabled={actionLoading === queue.id}
                        className={`btn-secondary text-[11px] py-1 px-2.5 ${
                          queue.is_paused ? 'text-emerald-400 border-emerald-500/30' : 'text-amber-400 border-amber-500/30'
                        }`}
                        title={queue.is_paused ? 'Resume Queue Processing' : 'Pause Queue Processing'}
                      >
                        {queue.is_paused ? <Play className="w-3 h-3" /> : <Pause className="w-3 h-3" />}
                        <span>{queue.is_paused ? 'Resume' : 'Pause'}</span>
                      </button>
                      <button
                        onClick={() => handlePurge(queue)}
                        disabled={actionLoading === queue.id}
                        className="btn-danger text-[11px] py-1 px-2"
                        title="Purge pending jobs in this queue"
                      >
                        <Trash2 className="w-3 h-3" />
                        <span>Purge</span>
                      </button>
                    </div>
                  </div>
                </div>

                {/* Shard Partition Grid */}
                <div>
                  <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider mb-2.5 flex items-center justify-between">
                    <span>Active Partitions ({shardCount} Shards)</span>
                    <span className="text-slate-500 font-mono font-normal">Round-Robin &amp; Least-Loaded Balanced</span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
                    {shards.map((shard) => {
                      const pending = shard.pending_count || 0;
                      const running = shard.running_count || 0;
                      const completed = shard.completed_count || 0;
                      const failed = shard.failed_count || 0;
                      const loadPct = Math.min(100, Math.round((pending / 20) * 100));

                      return (
                        <div
                          key={shard.id || shard.shard_index}
                          className="bg-slate-950/70 p-3.5 rounded-xl border border-slate-800/80 space-y-2.5"
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-indigo-300 font-mono">
                              Shard #{shard.shard_index}
                            </span>
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold">
                              ACTIVE
                            </span>
                          </div>

                          {/* Progress bar */}
                          <div>
                            <div className="flex justify-between text-[11px] text-slate-400 mb-1">
                              <span>Load Density</span>
                              <span className="font-semibold text-slate-300 font-mono">{pending} pending</span>
                            </div>
                            <div className="progress-track h-1.5">
                              <div
                                className="progress-fill"
                                style={{
                                  width: `${Math.max(4, loadPct)}%`,
                                  background: loadPct > 80 ? '#f43f5e' : loadPct > 40 ? '#f59e0b' : '#6366f1'
                                }}
                              />
                            </div>
                          </div>

                          {/* Micro Stats */}
                          <div className="grid grid-cols-3 gap-1 pt-1.5 text-center border-t border-slate-800/60 text-[11px] font-mono">
                            <div>
                              <div className="text-[9px] uppercase font-semibold text-slate-500">Run</div>
                              <div className="font-bold text-emerald-400">{running}</div>
                            </div>
                            <div>
                              <div className="text-[9px] uppercase font-semibold text-slate-500">Done</div>
                              <div className="font-bold text-slate-300">{completed}</div>
                            </div>
                            <div>
                              <div className="text-[9px] uppercase font-semibold text-slate-500">Fail</div>
                              <div className="font-bold text-rose-400">{failed}</div>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
