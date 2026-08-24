import React, { useEffect, useState, useCallback } from 'react';
import { RefreshCw, Activity, Terminal, History, Server, Shield, Zap, AlertTriangle, ArrowUpRight, CheckCircle2, Play, Square, Pause } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';
import { LiveCheckpointTerminal } from '../components/LiveCheckpointTerminal.jsx';

export const WorkerFleet = () => {
  const { user } = useAuth();
  const { currentOrg, currentProject } = useProject();
  const { lastEvent } = useWebSocket();
  const [workers, setWorkers] = useState([]);
  const [selectedWorker, setSelectedWorker] = useState(null);
  const [workerDetails, setWorkerDetails] = useState(null);
  const [executions, setExecutions] = useState([]);
  const [activeModalTab, setActiveModalTab] = useState('executions');
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoscaleData, setAutoscaleData] = useState(null);
  const [targetScale, setTargetScale] = useState(2);
  const [isScaling, setIsScaling] = useState(false);

  const isAdmin = user?.role === 'admin';

  const fetchWorkers = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const [wRes, aRes] = await Promise.all([
        api.workers.list(),
        api.workers.getAutoscale().catch(() => null)
      ]);
      setWorkers(wRes.data || []);
      if (aRes?.data) {
        setAutoscaleData(aRes.data);
        setTargetScale(aRes.data.activeWorkersCount || 2);
      }
    } catch (err) {
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchWorkers();
    const interval = setInterval(fetchWorkers, 3000);
    return () => clearInterval(interval);
  }, [fetchWorkers]);

  useEffect(() => {
    if (lastEvent && (lastEvent.type?.startsWith('WORKER_') || lastEvent.type?.startsWith('HEARTBEAT_') || lastEvent.type?.startsWith('AUTOSCALE_') || lastEvent.type?.startsWith('CHECKPOINT_'))) {
      fetchWorkers();
    }
  }, [lastEvent, fetchWorkers]);

  const handleOpenDetails = async (workerId) => {
    setSelectedWorker(workerId);
    setActiveModalTab('executions');
    try {
      const [wRes, eRes] = await Promise.all([
        api.workers.getById(workerId),
        api.workers.getExecutions(workerId, currentOrg?.id, isAdmin)
      ]);
      setWorkerDetails(wRes.data);
      setExecutions(eRes.data || []);
    } catch (err) { }
  };

  const handleDrain = async (e, workerId) => {
    e.stopPropagation();
    try {
      await api.workers.drain(workerId);
      fetchWorkers();
    } catch (err) { }
  };

  const handleStop = async (e, workerId) => {
    e.stopPropagation();
    try {
      await api.workers.stop(workerId);
      fetchWorkers();
    } catch (err) { }
  };

  const handleScaleFleet = async (count) => {
    if (!isAdmin) return;
    try {
      setIsScaling(true);
      const res = await api.workers.scaleFleet(count);
      if (res?.data) {
        setAutoscaleData(res.data);
        fetchWorkers();
      }
    } catch (err) {
    } finally {
      setIsScaling(false);
    }
  };

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
            <Server className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Worker Fleet &amp; Auto-Scale</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Workload-aware worker provisioning, atomic slot claiming, heartbeat health telemetry &amp; graceful drain
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={fetchWorkers}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Worker List"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Fleet Telemetry Cards */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <Activity className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-bold text-white">Workload-Aware Autonomous Worker Auto-Scaler</span>
            <span className="badge badge-healthy text-[10px]">
              ● ACTIVE
            </span>
          </div>
          <span className="text-xs text-slate-400 font-mono">
            Baseline: 2 / project · Burst Scaling on Backlog Surge
          </span>
        </div>

        <p className="text-xs text-slate-400 leading-relaxed">
          Continuously monitors project queue backlogs across all partitions. Spawns dedicated worker instances dynamically during bursts, and gracefully drains surplus workers back to baseline when idle.
        </p>

        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-1">
          <div className="rounded-xl bg-slate-950/60 border border-slate-800/80 p-3 text-center">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block">Active Nodes</span>
            <span className="text-xl font-black text-white mt-1 block">{autoscaleData?.activeWorkersCount || workers.length}</span>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800/80 p-3 text-center">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block">Total Slots</span>
            <span className="text-xl font-black text-cyan-400 mt-1 block">{autoscaleData?.totalCapacitySlots || (workers.length * 5)} slots</span>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800/80 p-3 text-center">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block">Queued Backlog</span>
            <span className="text-xl font-black text-amber-400 mt-1 block">{autoscaleData?.queuedJobs || 0} jobs</span>
          </div>
          <div className="rounded-xl bg-slate-950/60 border border-slate-800/80 p-3 text-center">
            <span className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold block">Fleet Load</span>
            <span className="text-xl font-black text-emerald-400 mt-1 block">{autoscaleData?.capacityUtilizationPercent || 0}%</span>
          </div>
        </div>

        {autoscaleData?.lastScaleAction && (
          <div className="text-[11px] font-mono text-slate-300 bg-slate-950/80 rounded-xl p-2.5 border border-slate-800/80 flex items-center justify-between">
            <span>Status: <span className="text-emerald-400 font-semibold">{autoscaleData.lastScaleAction}</span></span>
            <span className="text-slate-500">{new Date(autoscaleData.lastScaleTime).toLocaleTimeString()}</span>
          </div>
        )}
      </div>

      {/* Worker Instance Cards Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {loading ? (
          <div className="lg:col-span-3 glass-card p-12 text-center text-xs text-slate-500">
            <RefreshCw className="w-5 h-5 animate-spin mx-auto text-indigo-400 mb-2" />
            <span>Discovering active worker instances...</span>
          </div>
        ) : workers.length === 0 ? (
          <div className="lg:col-span-3 glass-card p-12 text-center text-xs text-slate-500">
            No active worker instances found. Launch workers using <code className="text-indigo-300 font-mono">node src/index.js</code> or the launch script.
          </div>
        ) : (
          workers.map((w) => {
            const loadPercent = Math.min(100, Math.round(((w.active_jobs_count || 0) / (w.concurrency_limit || 5)) * 100));

            return (
              <div
                key={w.id}
                onClick={() => handleOpenDetails(w.id)}
                className="glass-card p-5 space-y-3.5 cursor-pointer"
              >
                <div className="flex items-start justify-between">
                  <div>
                    <h3 className="text-sm font-bold text-white font-mono truncate max-w-[200px]">{w.id}</h3>
                    <p className="text-[11px] font-mono text-slate-500 mt-0.5">
                      {w.hostname} ({w.ip_address})
                    </p>
                  </div>
                  <Badge status={w.status} />
                </div>

                <div className="space-y-1.5">
                  <div className="flex justify-between text-xs text-slate-400">
                    <span>Concurrency Load</span>
                    <span className="font-semibold text-slate-200">
                      {w.active_jobs_count} / {w.concurrency_limit} ({loadPercent}%)
                    </span>
                  </div>
                  <div className="progress-track">
                    <div
                      className="progress-fill"
                      style={{
                        width: `${loadPercent}%`,
                        background: loadPercent > 80 ? '#f43f5e' : loadPercent > 40 ? '#f59e0b' : '#6366f1'
                      }}
                    />
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 rounded-xl bg-slate-950/60 border border-slate-800/80 p-2.5 text-center text-xs">
                  <div>
                    <span className="text-[10px] uppercase font-semibold text-slate-500 block">Processed</span>
                    <span className="font-bold text-slate-200 mt-0.5 block">{w.total_jobs_processed}</span>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase font-semibold text-slate-500 block">Failed</span>
                    <span className="font-bold text-rose-400 mt-0.5 block">{w.failed_jobs_count}</span>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-500 pt-2 border-t border-slate-800/80">
                  <span className="font-mono text-[11px]">Heartbeat: {w.seconds_since_heartbeat || 0}s ago</span>
                  <div className="flex items-center gap-1.5" onClick={(e) => e.stopPropagation()}>
                    {w.status !== 'draining' && w.status !== 'stopped' && (
                      <button
                        onClick={(e) => handleDrain(e, w.id)}
                        className="btn-secondary text-[11px] py-1 px-2 text-amber-400"
                        title="Drain in-flight jobs gracefully"
                      >
                        Drain
                      </button>
                    )}
                    {isAdmin && w.status !== 'stopped' && (
                      <button
                        onClick={(e) => handleStop(e, w.id)}
                        className="btn-danger text-[11px] py-1 px-2"
                        title="Stop and decommission worker"
                      >
                        Stop
                      </button>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Live Checkpoint Terminal Log Feed */}
      <div className="glass-card p-5">
        <LiveCheckpointTerminal />
      </div>

      {/* Worker Inspect Modal */}
      {selectedWorker && (
        <Modal
          isOpen={!!selectedWorker}
          onClose={() => setSelectedWorker(null)}
          title={`Worker Node Inspection: ${selectedWorker}`}
          maxWidth="max-w-4xl"
        >
          <div className="space-y-4 text-xs">
            {/* Tabs */}
            <div className="flex gap-2 border-b border-slate-800 pb-2">
              <button
                onClick={() => setActiveModalTab('executions')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition-all ${
                  activeModalTab === 'executions'
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <History className="w-3.5 h-3.5" />
                <span>Execution History ({executions.length})</span>
              </button>
              <button
                onClick={() => setActiveModalTab('heartbeats')}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg font-semibold transition-all ${
                  activeModalTab === 'heartbeats'
                    ? 'bg-indigo-600/20 text-indigo-300 border border-indigo-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                <Activity className="w-3.5 h-3.5" />
                <span>Heartbeat Telemetry</span>
              </button>
            </div>

            {activeModalTab === 'executions' && (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {executions.length === 0 ? (
                  <div className="p-8 text-center text-slate-500 italic">No job executions recorded for this worker.</div>
                ) : (
                  executions.map((e) => (
                    <div key={e.id} className="flex items-center justify-between p-3 rounded-xl bg-slate-950/60 border border-slate-800/80">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-slate-200">{e.job_name}</span>
                          <Badge status={e.status} />
                          <span className="text-[10px] text-slate-500 font-mono">Attempt #{e.attempt_number}</span>
                        </div>
                        <p className="text-[10px] text-slate-500 font-mono">Project: {e.project_name || 'default'}</p>
                      </div>
                      <div className="text-right font-mono text-slate-400 text-[11px]">
                        <p className="text-slate-200 font-bold">{e.duration_ms ? `${e.duration_ms}ms` : 'running...'}</p>
                        <p className="text-[10px] text-slate-500">{new Date(e.started_at).toLocaleTimeString()}</p>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}

            {activeModalTab === 'heartbeats' && (
              <div className="space-y-2 max-h-72 overflow-y-auto pr-1">
                {(!workerDetails?.heartbeats || workerDetails.heartbeats.length === 0) ? (
                  <div className="p-8 text-center text-slate-500 italic">No heartbeat history available.</div>
                ) : (
                  workerDetails.heartbeats.map((hb, i) => (
                    <div key={i} className="flex items-center justify-between p-2.5 rounded-xl bg-slate-950/60 border border-slate-800/80 font-mono text-[11px]">
                      <div className="flex items-center gap-2">
                        <span className="w-2 h-2 rounded-full bg-emerald-400" />
                        <span className="text-slate-300">Active Jobs: {hb.active_jobs_count} / {hb.concurrency_limit}</span>
                        <span className="text-slate-500">Status: {hb.status}</span>
                      </div>
                      <span className="text-slate-500">{new Date(hb.timestamp).toLocaleTimeString()}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </Modal>
      )}
    </div>
  );
};
