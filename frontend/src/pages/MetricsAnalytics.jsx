import React, { useEffect, useState, useCallback } from 'react';
import {
  Clock, Layers, TrendingUp, RefreshCw, Zap, Activity, Lock, ShieldCheck,
  Server, Cpu, Gauge, Box, ArrowUpRight, TrendingDown, CheckCircle2, AlertTriangle,
  Flame, Radio, BarChart3, Database, Globe, Key, Shield
} from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { useProject } from '../context/ProjectContext.jsx';
import { Badge } from '../components/Badge.jsx';

export const MetricsAnalytics = () => {
  const { currentOrg, currentProject } = useProject();
  const { lastEvent } = useWebSocket();
  const [overview, setOverview] = useState(null);
  const [latencyData, setLatencyData] = useState([]);
  const [queueDepths, setQueueDepths] = useState([]);
  const [throughputData, setThroughputData] = useState([]);
  const [autoscalerMetrics, setAutoscalerMetrics] = useState(null);
  const [activeLocks, setActiveLocks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchMetrics = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const [ovRes, latRes, qdRes, tpRes, autoRes, locksRes] = await Promise.all([
        api.metrics.getOverview(currentOrg?.id).catch(() => ({ data: null })),
        api.metrics.getLatency(currentOrg?.id).catch(() => ({ data: [] })),
        api.metrics.getQueueDepths(currentOrg?.id).catch(() => ({ data: [] })),
        api.metrics.getThroughput(currentOrg?.id).catch(() => ({ data: [] })),
        api.metrics.getAutoscaler().catch(() => ({ data: null })),
        api.metrics.getLocks().catch(() => ({ data: [] }))
      ]);

      setOverview(ovRes?.data || null);
      setLatencyData(latRes?.data || []);
      setQueueDepths(qdRes?.data || []);
      setThroughputData(tpRes?.data || []);
      setAutoscalerMetrics(autoRes?.data || null);
      setActiveLocks(locksRes?.data || []);
    } catch (err) {
      console.error('Failed to fetch metrics:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [currentOrg?.id]);

  useEffect(() => {
    fetchMetrics();
    const interval = setInterval(fetchMetrics, 3000);
    return () => clearInterval(interval);
  }, [fetchMetrics]);

  useEffect(() => {
    if (lastEvent) {
      fetchMetrics();
    }
  }, [lastEvent, fetchMetrics]);

  const totalCapacitySlots = autoscalerMetrics?.totalCapacitySlots || (overview?.activeWorkers * 5) || 10;
  const activeUsedSlots = autoscalerMetrics?.activeUsedSlots || 0;
  const utilPercent = totalCapacitySlots > 0 ? Math.round((activeUsedSlots / totalCapacitySlots) * 100) : 0;
  const scaleEvents = autoscalerMetrics?.scaleEvents || [];

  const displayedQueues = currentProject
    ? queueDepths.filter((q) => !q.projectName || q.projectName === currentProject.name)
    : queueDepths;
  const effectiveQueues = displayedQueues.length > 0 ? displayedQueues : queueDepths;

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20 text-cyan-400">
            <Activity className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">System Metrics &amp; Telemetry</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Production telemetry across single authoritative scheduler, dedicated queues, and worker fleet
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-semibold">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>Telemetry Live Stream</span>
          </div>
          <button
            onClick={fetchMetrics}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Metrics"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-cyan-400' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Primary KPI Row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="glass-card p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Fleet Utilization</span>
            <Gauge className="w-4 h-4 text-cyan-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-white">{utilPercent}%</span>
            <span className="text-xs text-slate-500 font-mono">({activeUsedSlots}/{totalCapacitySlots} slots)</span>
          </div>
          <div className="progress-track h-1.5 mt-1">
            <div
              className="progress-fill"
              style={{
                width: `${Math.max(4, utilPercent)}%`,
                background: utilPercent > 80 ? '#f43f5e' : utilPercent > 50 ? '#f59e0b' : '#06b6d4'
              }}
            />
          </div>
        </div>

        <div className="glass-card p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Average Latency</span>
            <Clock className="w-4 h-4 text-indigo-400" />
          </div>
          <div className="flex items-baseline gap-1.5">
            <span className="text-2xl font-black text-indigo-400 font-mono">{overview?.avgDurationMs || 0}</span>
            <span className="text-xs text-slate-500 font-mono">ms</span>
          </div>
          <p className="text-[10px] text-slate-500 font-mono">
            Min: {overview?.minDurationMs || 0}ms &bull; Max: {overview?.maxDurationMs || 0}ms
          </p>
        </div>

        <div className="glass-card p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Success Rate</span>
            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-emerald-400">{overview?.successRate || 100}%</span>
            <span className="text-xs text-slate-500 font-mono">({overview?.statusDistribution?.completed || 0} done)</span>
          </div>
          <p className="text-[10px] text-slate-500 font-mono">
            Failures: {overview?.statusDistribution?.failed || 0} &bull; DLQ: {overview?.unresolvedDlq || 0}
          </p>
        </div>

        <div className="glass-card p-4 space-y-1.5">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Scheduler Engine</span>
            <ShieldCheck className="w-4 h-4 text-amber-400" />
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold text-white">Single Authoritative</span>
          </div>
          <p className="text-[10px] text-amber-400 font-mono">
            Priority + Dynamic Aging Active
          </p>
        </div>
      </div>

      {/* Secondary Metrics: Worker Fleet & Shard Partitions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Worker Fleet Autoscaler State */}
        <div className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
            <div className="flex items-center gap-2.5">
              <Server className="w-5 h-5 text-indigo-400" />
              <div>
                <h3 className="text-sm font-bold text-white">Workload-Aware Worker Fleet</h3>
                <p className="text-xs text-slate-400">Autonomous dynamic capacity scaling on backlogs</p>
              </div>
            </div>
            <span className="badge badge-healthy text-[10px]">
              {autoscalerMetrics?.activeWorkersCount || overview?.activeWorkers || 2} Active Nodes
            </span>
          </div>

          <div className="grid grid-cols-3 gap-3 text-center">
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
              <span className="text-[10px] text-slate-500 uppercase font-semibold">Baseline</span>
              <p className="text-base font-black text-white mt-0.5 font-mono">2 Nodes</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
              <span className="text-[10px] text-slate-500 uppercase font-semibold">Backlog Threshold</span>
              <p className="text-base font-black text-indigo-400 mt-0.5 font-mono">8 Jobs/Node</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
              <span className="text-[10px] text-slate-500 uppercase font-semibold">Drain Cooldown</span>
              <p className="text-base font-black text-amber-400 mt-0.5 font-mono">
                {autoscalerMetrics?.scaleDownCooldownRemainingSec > 0 ? `${autoscalerMetrics.scaleDownCooldownRemainingSec}s` : 'Ready'}
              </p>
            </div>
          </div>

          <div>
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block mb-2">
              Recent Fleet Scale Activity
            </span>
            <div className="space-y-2 max-h-40 overflow-y-auto pr-1">
              {scaleEvents.length === 0 ? (
                <p className="text-xs text-slate-500 italic py-2">Baseline fleet active (no scale burst triggers yet)</p>
              ) : (
                scaleEvents.slice().reverse().map((ev, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/50 border border-slate-800/60 text-xs"
                  >
                    <div className="flex items-center gap-2">
                      {ev.action === 'SCALE_UP' ? (
                        <ArrowUpRight className="w-4 h-4 text-emerald-400" />
                      ) : (
                        <TrendingDown className="w-4 h-4 text-amber-400" />
                      )}
                      <span className="font-semibold text-slate-200">
                        {ev.action}: {ev.action === 'SCALE_UP' ? `+${ev.addedWorkers}` : `-${ev.removedWorkers}`} node(s)
                      </span>
                    </div>
                    <span className="text-slate-500 text-[11px] font-mono">
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Queue Partitions & Depths */}
        <div className="glass-card p-5 space-y-4">
          <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
            <div className="flex items-center gap-2.5">
              <Box className="w-5 h-5 text-cyan-400" />
              <div>
                <h3 className="text-sm font-bold text-white">Dedicated Service Queues</h3>
                <p className="text-xs text-slate-400">1 queue per service with 2 baseline shards</p>
              </div>
            </div>
            <span className="badge badge-running text-[10px]">
              {effectiveQueues.reduce((s, q) => s + (q.shardCount || q.shards?.length || 2), 0)} Active Shards
            </span>
          </div>

          <div className="space-y-2.5 max-h-60 overflow-y-auto pr-1">
            {effectiveQueues.length === 0 ? (
              <p className="text-xs text-slate-500 italic py-4 text-center">Service queues are initializing...</p>
            ) : (
              effectiveQueues.map((q) => (
                <div
                  key={q.id}
                  className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80 space-y-2"
                >
                  <div className="flex items-center justify-between">
                    <div>
                      <span className="font-bold text-slate-200 text-xs">{q.name}</span>
                      <span className="text-[10px] text-slate-500 ml-2 font-mono">P{q.priority}</span>
                    </div>
                    <span className="text-xs font-mono font-bold text-cyan-400">
                      {q.shardCount || 2} Shards &bull; {q.depth || 0} queued
                    </span>
                  </div>

                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5 pt-1">
                    {(q.shards && q.shards.length > 0 ? q.shards : [{ shard_index: 0 }, { shard_index: 1 }]).map((sh, sIdx) => (
                      <div key={sIdx} className="p-1.5 rounded-lg bg-slate-900/90 border border-slate-800/80 text-center">
                        <div className="text-[9px] text-slate-500 font-mono">Shard #{sh.shard_index ?? sIdx}</div>
                        <div className="text-[11px] font-bold text-slate-200 font-mono">
                          {sh.pending_count || 0} pending
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Autonomous Queue & Shard Job Snatching Telemetry */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <Zap className="w-5 h-5 text-cyan-400" />
            <div>
              <h3 className="text-sm font-bold text-white">Autonomous Queue &amp; Shard Job Snatching</h3>
              <p className="text-xs text-slate-400">Cross-shard and cross-queue dynamic work stealing when backlogs surge</p>
            </div>
          </div>
          <span className="badge badge-running text-[10px]">
            {autoscalerMetrics?.shardSnatcher?.totalJobsSnatched || 0} Total Jobs Snatched
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-center">
          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span className="text-[10px] text-slate-500 uppercase font-semibold">Cross-Shard Snatching</span>
            <p className="text-lg font-black text-cyan-400 mt-0.5 font-mono">
              {autoscalerMetrics?.shardSnatcher?.crossShardSnatches || 0}
            </p>
            <span className="text-[9px] text-slate-500">Idle shards snatching from busy shards</span>
          </div>

          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span className="text-[10px] text-slate-500 uppercase font-semibold">Cross-Queue Absorption</span>
            <p className="text-lg font-black text-indigo-400 mt-0.5 font-mono">
              {autoscalerMetrics?.shardSnatcher?.crossQueueSnatches || 0}
            </p>
            <span className="text-[9px] text-slate-500">Idle service queues absorbing overflow</span>
          </div>

          <div className="p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
            <span className="text-[10px] text-slate-500 uppercase font-semibold">Snatching Engine</span>
            <p className="text-lg font-black text-emerald-400 mt-0.5 font-mono">Autonomous</p>
            <span className="text-[9px] text-slate-500">Zero queue &amp; shard idle time</span>
          </div>
        </div>
      </div>

      {/* Latency Breakdown by Execution Service */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800/80">
          <div className="flex items-center gap-2.5">
            <BarChart3 className="w-5 h-5 text-indigo-400" />
            <div>
              <h3 className="text-sm font-bold text-white">Execution Latency &amp; Percentiles by Service</h3>
              <p className="text-xs text-slate-400">P50, P90, and P99 latency distributions across execution types</p>
            </div>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="djs-table">
            <thead>
              <tr>
                <th>Service Type</th>
                <th className="text-center">Executions</th>
                <th className="text-right">Avg (ms)</th>
                <th className="text-right">Min (ms)</th>
                <th className="text-right text-indigo-400">P50 (ms)</th>
                <th className="text-right text-cyan-400">P90 (ms)</th>
                <th className="text-right text-rose-400">P99 (ms)</th>
                <th className="text-right">Max (ms)</th>
              </tr>
            </thead>
            <tbody>
              {latencyData.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-slate-500 italic">
                    No execution latency samples available yet. Dispatch jobs to see latency percentiles.
                  </td>
                </tr>
              ) : (
                latencyData.map((row) => (
                  <tr key={row.jobType} className="hover:bg-slate-800/20 transition">
                    <td className="font-mono text-xs font-semibold text-slate-200">
                      <div className="flex items-center gap-2">
                        {row.jobType === 'http_request' && <Globe className="w-3.5 h-3.5 text-blue-400" />}
                        {row.jobType === 'db_query' && <Database className="w-3.5 h-3.5 text-emerald-400" />}
                        {row.jobType === 'cpu_compute' && <Cpu className="w-3.5 h-3.5 text-amber-400" />}
                        {row.jobType === 'notification_event' && <Zap className="w-3.5 h-3.5 text-purple-400" />}
                        <span>{row.jobType}</span>
                      </div>
                    </td>
                    <td className="text-center text-slate-300 font-semibold">{row.count}</td>
                    <td className="text-right text-slate-200 font-mono font-bold">{row.avgDurationMs}</td>
                    <td className="text-right text-slate-400 font-mono">{row.minDurationMs}</td>
                    <td className="text-right text-indigo-400 font-mono font-semibold">{row.p50DurationMs || row.avgDurationMs}</td>
                    <td className="text-right text-cyan-400 font-mono font-semibold">{row.p90DurationMs || row.maxDurationMs}</td>
                    <td className="text-right text-rose-400 font-mono font-semibold">{row.p99DurationMs || row.maxDurationMs}</td>
                    <td className="text-right text-slate-400 font-mono">{row.maxDurationMs}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
