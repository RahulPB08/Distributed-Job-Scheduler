import React, { useEffect, useState, useCallback } from 'react';
import {
  LayoutDashboard, RefreshCw, Zap, Server, CheckCircle2, XCircle,
  Clock, Activity, Layers, TrendingUp, TrendingDown, AlertTriangle,
  ArrowUpRight, Play, Pause, BarChart3, Cpu
} from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';

const STATUS_CONFIG = {
  queued:    { label: 'Queued',    color: '#fbbf24', bg: 'rgba(245,158,11,0.1)',  border: 'rgba(245,158,11,0.25)' },
  scheduled: { label: 'Scheduled', color: '#a5b4fc', bg: 'rgba(99,102,241,0.1)',  border: 'rgba(99,102,241,0.25)' },
  claimed:   { label: 'Claimed',   color: '#c4b5fd', bg: 'rgba(139,92,246,0.1)',  border: 'rgba(139,92,246,0.25)' },
  running:   { label: 'Running',   color: '#67e8f9', bg: 'rgba(6,182,212,0.1)',   border: 'rgba(6,182,212,0.25)' },
  completed: { label: 'Completed', color: '#6ee7b7', bg: 'rgba(16,185,129,0.1)',  border: 'rgba(16,185,129,0.25)' },
  failed:    { label: 'Failed',    color: '#fda4af', bg: 'rgba(244,63,94,0.1)',   border: 'rgba(244,63,94,0.25)' },
  dlq:       { label: 'DLQ',       color: '#fca5a5', bg: 'rgba(239,68,68,0.1)',   border: 'rgba(239,68,68,0.25)' },
};

function StatusBar({ distribution, total }) {
  if (!total) return null;
  const segments = Object.entries(distribution || {}).filter(([, v]) => v > 0);
  return (
    <div className="flex h-2 rounded-full overflow-hidden gap-0.5 bg-slate-900">
      {segments.map(([key, val]) => {
        const cfg = STATUS_CONFIG[key];
        if (!cfg) return null;
        const pct = Math.max(2, (val / total) * 100);
        return (
          <div key={key} className="rounded-full transition-all duration-700" title={`${cfg.label}: ${val}`}
            style={{ background: cfg.color, width: `${pct}%`, opacity: 0.85 }} />
        );
      })}
    </div>
  );
}

function KpiCard({ label, value, sub, icon: Icon, color, bg, trend }) {
  return (
    <div className="stat-card animate-fade-in-up">
      <div className="flex items-start justify-between mb-3">
        <div className="p-2.5 rounded-xl border" style={{ background: bg, borderColor: bg?.replace('0.1', '0.25') }}>
          <Icon className="w-5 h-5" style={{ color }} />
        </div>
        {trend !== undefined && (
          <div className={`flex items-center gap-1 text-xs font-semibold px-2 py-1 rounded-lg ${
            trend >= 0 ? 'text-emerald-400 bg-emerald-400/10' : 'text-rose-400 bg-rose-400/10'
          }`}>
            {trend >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
            <span>{Math.abs(trend)}%</span>
          </div>
        )}
      </div>
      <div className="text-3xl font-black text-white tracking-tight">{value ?? '—'}</div>
      <div className="text-sm font-semibold text-slate-300 mt-0.5">{label}</div>
      {sub && <div className="text-xs text-slate-500 mt-1">{sub}</div>}
    </div>
  );
}

export const Dashboard = ({ onViewJob, onNavigate }) => {
  const { currentProject } = useProject();
  const { lastEvent } = useWebSocket();
  const [metrics, setMetrics] = useState(null);
  const [recentJobs, setRecentJobs] = useState([]);
  const [workers, setWorkers] = useState([]);
  const [autoscale, setAutoscale] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState(null);

  const load = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const [ovRes, jobsRes, wRes, aRes] = await Promise.all([
        api.metrics.getOverview().catch(() => null),
        api.jobs.list({ projectId: currentProject?.id, limit: 8, sortBy: 'newest' }).catch(() => null),
        api.workers.list().catch(() => null),
        api.workers.getAutoscale().catch(() => null),
      ]);
      if (ovRes?.data)   setMetrics(ovRes.data);
      if (jobsRes?.data) {
        const j = jobsRes.data;
        setRecentJobs(Array.isArray(j) ? j : (j.jobs || []));
      }
      if (wRes?.data)    setWorkers(Array.isArray(wRes.data) ? wRes.data : []);
      if (aRes?.data)    setAutoscale(aRes.data);
      setLastRefreshed(new Date());
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [currentProject?.id]);

  useEffect(() => { load(); const t = setInterval(load, 3000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (lastEvent) load(); }, [lastEvent, load]);

  const dist = metrics?.statusDistribution || {};
  const totalJobs = metrics?.totalJobs || 0;
  const activeW = workers.filter(w => w.status === 'healthy' || w.status === 'degraded');
  const utilPct = autoscale?.capacityUtilizationPercent ?? metrics?.fleetUtilizationPercent ?? 0;
  const successRate = metrics?.successRate ?? 100;

  if (loading) {
    return (
      <div className="space-y-5 animate-fade-in">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="stat-card"><div className="skeleton h-16 rounded-lg" /></div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
            <LayoutDashboard className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">System Overview</h1>
            <p className="text-xs text-slate-500 mt-0.5">
              {lastRefreshed ? `Updated ${lastRefreshed.toLocaleTimeString()}` : 'Loading...'}
            </p>
          </div>
        </div>
        <button onClick={load} disabled={isRefreshing}
          className="btn-ghost text-xs gap-2">
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow' : ''}`} />
          Refresh
        </button>
      </div>

      {/* KPI Cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard label="Total Jobs" value={totalJobs.toLocaleString()} icon={Zap}
          color="#a5b4fc" bg="rgba(99,102,241,0.1)"
          sub={`${dist.queued || 0} queued · ${dist.running || 0} running`} />
        <KpiCard label="Active Workers" value={activeW.length} icon={Server}
          color="#6ee7b7" bg="rgba(16,185,129,0.1)"
          sub={`${utilPct}% capacity used`} />
        <KpiCard label="Success Rate" value={`${successRate}%`} icon={CheckCircle2}
          color="#6ee7b7" bg="rgba(16,185,129,0.1)"
          sub={`${dist.completed || 0} completed`} />
        <KpiCard label="DLQ / Failed" value={(dist.dlq || 0) + (dist.failed || 0)} icon={AlertTriangle}
          color="#fda4af" bg="rgba(244,63,94,0.1)"
          sub={`${metrics?.unresolvedDlq || 0} unresolved`} />
      </div>

      {/* Status pipeline */}
      <div className="glass-card p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="font-bold text-white">Job Status Pipeline</p>
            <p className="text-xs text-slate-500 mt-0.5">{totalJobs.toLocaleString()} total jobs across all queues</p>
          </div>
          <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <div className="live-dot" />
            <span className="text-xs text-emerald-400 font-semibold">Live</span>
          </div>
        </div>

        <StatusBar distribution={dist} total={totalJobs} />

        <div className="grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-7 gap-3 mt-4">
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
            <div key={key} className="text-center p-2.5 rounded-xl border transition-all duration-200"
              style={{ background: cfg.bg, borderColor: cfg.border }}>
              <div className="text-lg font-black" style={{ color: cfg.color }}>{dist[key] || 0}</div>
              <div className="text-[10px] font-semibold text-slate-400 mt-0.5">{cfg.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Situation-Aware Adaptive Multi-Queue & Shard Distribution Banner */}
      <div className="glass-card p-4 bg-gradient-to-r from-indigo-950/40 via-slate-900/60 to-cyan-950/40 border-indigo-500/30 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-indigo-500/20 text-indigo-300">
            <Zap className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-xs font-bold text-white">Situation-Aware Adaptive Scheduling &amp; Multi-Queue Shard Balancing</h3>
            <p className="text-[11px] text-slate-400">
              Dynamically distributes incoming jobs to least-loaded shards and alternative service queues during congestion surges
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2 text-xs font-mono">
          <span className="px-2.5 py-1 rounded-full bg-emerald-500/15 text-emerald-300 border border-emerald-500/30 font-semibold">
            ● Adaptive Balancer Active
          </span>
        </div>
      </div>

      {/* Grid: Workers + Recent Jobs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Worker Fleet */}
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <Server className="w-4 h-4 text-emerald-400" />
              <div>
                <p className="font-bold text-white">Worker Fleet</p>
                <p className="text-xs text-slate-500">{activeW.length} active nodes</p>
              </div>
            </div>
            <button onClick={() => onNavigate?.('workers')}
              className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              View All <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>

          {/* Utilization bar */}
          <div className="mb-4">
            <div className="flex justify-between text-xs text-slate-400 mb-1.5">
              <span>Fleet Utilization</span>
              <span className="font-semibold text-white">{utilPct}%</span>
            </div>
            <div className="progress-track">
              <div className="progress-fill"
                style={{ width: `${utilPct}%`, background: utilPct > 80 ? '#f43f5e' : utilPct > 50 ? '#f59e0b' : '#06b6d4' }} />
            </div>
          </div>

          <div className="space-y-2 max-h-52 overflow-y-auto">
            {workers.length === 0 ? (
              <p className="text-xs text-slate-500 italic text-center py-4">No workers registered yet</p>
            ) : workers.slice(0, 6).map(w => {
              const statusColor = w.status === 'healthy' ? '#6ee7b7' : w.status === 'degraded' ? '#fbbf24' : '#fda4af';
              const used = w.active_jobs_count || 0;
              const cap = w.concurrency_limit || 5;
              const pct = Math.round((used / cap) * 100);
              return (
                <div key={w.id} className="flex items-center gap-3 p-2.5 rounded-xl bg-slate-900/60 border border-slate-800/60">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: statusColor, boxShadow: `0 0 6px ${statusColor}60` }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-mono font-semibold text-slate-200 truncate">{w.id}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <div className="progress-track h-1 flex-1">
                        <div className="progress-fill h-full" style={{ width: `${pct}%`, background: '#6366f1' }} />
                      </div>
                      <span className="text-[10px] text-slate-500 shrink-0">{used}/{cap}</span>
                    </div>
                  </div>
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded" style={{ background: `${statusColor}15`, color: statusColor }}>
                    {w.status}
                  </span>
                </div>
              );
            })}
          </div>
        </div>

        {/* Recent Jobs */}
        <div className="glass-card p-5">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2.5">
              <Activity className="w-4 h-4 text-cyan-400" />
              <div>
                <p className="font-bold text-white">Recent Jobs</p>
                <p className="text-xs text-slate-500">Latest activity across all queues</p>
              </div>
            </div>
            <button onClick={() => onNavigate?.('jobs')}
              className="flex items-center gap-1 text-xs text-indigo-400 hover:text-indigo-300 transition-colors">
              View All <ArrowUpRight className="w-3 h-3" />
            </button>
          </div>

          <div className="space-y-2 max-h-64 overflow-y-auto">
            {recentJobs.length === 0 ? (
              <div className="text-center py-8">
                <Play className="w-8 h-8 text-slate-700 mx-auto mb-2" />
                <p className="text-sm text-slate-500">No jobs yet. Create your first job!</p>
              </div>
            ) : recentJobs.map(job => {
              const cfg = STATUS_CONFIG[job.status] || {};
              return (
                <button key={job.id} onClick={() => onViewJob?.(job.id)}
                  className="w-full flex items-center gap-3 p-2.5 rounded-xl text-left transition-all duration-150 hover:bg-slate-800/40 border border-transparent hover:border-slate-800/60">
                  <div className="w-2 h-2 rounded-full shrink-0" style={{ background: cfg.color, boxShadow: `0 0 6px ${cfg.color}60` }} />
                  <div className="flex-1 min-w-0">
                    <p className="text-xs font-semibold text-slate-200 truncate">{job.name}</p>
                    <p className="text-[10px] text-slate-500 font-mono">{job.job_type}</p>
                  </div>
                  <span className="badge shrink-0" style={{ background: cfg.bg, color: cfg.color, borderColor: cfg.border }}>
                    {job.status}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* System health cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {[
          {
            label: 'Avg Execution', value: `${metrics?.avgDurationMs || 0}ms`,
            sub: `Min: ${metrics?.minDurationMs || 0}ms · Max: ${metrics?.maxDurationMs || 0}ms`,
            icon: Clock, color: '#a5b4fc',
          },
          {
            label: 'Total Executions', value: (metrics?.totalExecutions || 0).toLocaleString(),
            sub: 'Across all job types',
            icon: BarChart3, color: '#67e8f9',
          },
          {
            label: 'Failure Rate', value: `${metrics?.failureRate || 0}%`,
            sub: `${(dist.failed || 0) + (dist.dlq || 0)} failed / DLQ`,
            icon: XCircle, color: '#fda4af',
          },
        ].map(({ label, value, sub, icon: Icon, color }) => (
          <div key={label} className="flex items-center gap-4 p-4 glass-card">
            <div className="p-2.5 rounded-xl border shrink-0" style={{ background: `${color}12`, borderColor: `${color}25` }}>
              <Icon className="w-5 h-5" style={{ color }} />
            </div>
            <div>
              <p className="text-xl font-black text-white">{value}</p>
              <p className="text-xs font-semibold text-slate-300">{label}</p>
              <p className="text-[11px] text-slate-500 mt-0.5">{sub}</p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};
