import React, { useEffect, useState, useCallback, useRef } from 'react';
import {
  Activity,
  RefreshCw,
  Pause,
  Play,
  Search,
  Filter,
  Layers,
  Cpu,
  AlertTriangle,
  CheckCircle2,
  Zap,
  Radio,
  Server,
  ArrowUpRight
} from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';

export const EventManager = ({ onViewJob }) => {
  const { currentProject } = useProject();
  const { lastEvent, eventHistory } = useWebSocket();
  const [eventsList, setEventsList] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isFrozen, setIsFrozen] = useState(false);
  const [searchFilter, setSearchFilter] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('ALL');

  const isFrozenRef = useRef(isFrozen);
  useEffect(() => {
    isFrozenRef.current = isFrozen;
  }, [isFrozen]);

  const fetchEvents = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const eventsRes = await api.metrics.getEvents(100);
      if (!isFrozenRef.current && Array.isArray(eventsRes?.data)) {
        setEventsList(eventsRes.data);
      }
    } catch (err) {
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    const interval = setInterval(() => {
      if (!isFrozenRef.current) {
        fetchEvents();
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [fetchEvents]);

  useEffect(() => {
    if (lastEvent && !isFrozen) {
      setEventsList((prev) => [lastEvent, ...prev.slice(0, 99)]);
    }
  }, [lastEvent, isFrozen]);

  const workerEventsCount = eventsList.filter(
    (e) => e.type?.includes('WORKER') || e.type?.includes('AUTOSCALE') || e.event_type?.includes('WORKER')
  ).length;

  const shardEventsCount = eventsList.filter(
    (e) => e.type?.includes('SHARD') || e.event_type?.includes('SHARD') || e.type?.includes('QUEUE')
  ).length;

  const errorEventsCount = eventsList.filter(
    (e) => e.type?.includes('FAIL') || e.type?.includes('DLQ') || e.type?.includes('ERROR') || e.event_type?.includes('FAIL')
  ).length;

  const filteredEvents = eventsList.filter((ev) => {
    const text = `${ev.type || ev.event_type || ''} ${ev.message || ''} ${ev.worker_id || ev.workerId || ''} ${ev.job_id || ev.jobId || ''} ${JSON.stringify(ev.payload || ev.data || {})}`.toLowerCase();
    if (searchFilter && !text.includes(searchFilter.toLowerCase())) {
      return false;
    }

    const typeStr = (ev.type || ev.event_type || '').toUpperCase();
    if (categoryFilter === 'WORKER') {
      return typeStr.includes('WORKER') || typeStr.includes('AUTOSCALE');
    }
    if (categoryFilter === 'SHARD') {
      return typeStr.includes('SHARD') || typeStr.includes('QUEUE');
    }
    if (categoryFilter === 'ERROR') {
      return typeStr.includes('FAIL') || typeStr.includes('DLQ') || typeStr.includes('ERROR');
    }
    if (categoryFilter === 'JOB') {
      return typeStr.includes('JOB') || typeStr.includes('TASK');
    }
    return true;
  });

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Radio className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Event-Driven Telemetry Stream</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Live Redis Pub/Sub &amp; WebSocket audit logs across workers, job state transitions, and queues
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setIsFrozen(!isFrozen)}
            className={`btn-secondary text-xs gap-1.5 ${
              isFrozen
                ? 'border-amber-500/30 text-amber-300 bg-amber-500/10'
                : 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
            }`}
          >
            {isFrozen ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
            <span>{isFrozen ? 'Resume Live Stream' : 'Pause Stream'}</span>
          </button>
          <button
            onClick={fetchEvents}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Stream"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Metric Counters */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Total Captured</span>
            <Activity className="w-4 h-4 text-indigo-400" />
          </div>
          <p className="text-2xl font-black text-white">{eventsList.length}</p>
        </div>

        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Worker Events</span>
            <Server className="w-4 h-4 text-emerald-400" />
          </div>
          <p className="text-2xl font-black text-emerald-400">{workerEventsCount}</p>
        </div>

        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Queue / Shard</span>
            <Layers className="w-4 h-4 text-cyan-400" />
          </div>
          <p className="text-2xl font-black text-cyan-400">{shardEventsCount}</p>
        </div>

        <div className="glass-card p-4 space-y-1">
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Errors / Failures</span>
            <AlertTriangle className="w-4 h-4 text-rose-400" />
          </div>
          <p className="text-2xl font-black text-rose-400">{errorEventsCount}</p>
        </div>
      </div>

      {/* Category Filter & Search Bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 glass-card p-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { id: 'ALL', label: 'All Streams' },
            { id: 'JOB', label: 'Job State' },
            { id: 'WORKER', label: 'Worker Fleet' },
            { id: 'SHARD', label: 'Queue Partitions' },
            { id: 'ERROR', label: 'Errors & DLQ' },
          ].map(({ id, label }) => (
            <button
              key={id}
              onClick={() => setCategoryFilter(id)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold transition-all ${
                categoryFilter === id
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-600/30'
                  : 'text-slate-400 hover:text-slate-200 hover:bg-slate-800/60'
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        <div className="relative min-w-[240px]">
          <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            type="text"
            placeholder="Filter event payload..."
            value={searchFilter}
            onChange={(e) => setSearchFilter(e.target.value)}
            className="djs-input pl-10 text-xs py-1.5"
          />
        </div>
      </div>

      {/* Live Events Stream List */}
      <div className="glass-card p-5 space-y-3">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <span className="font-bold text-white text-sm">Realtime Event Stream</span>
          </div>
          <span className="font-mono text-xs text-slate-500">{filteredEvents.length} events matching filter</span>
        </div>

        <div className="space-y-2 max-h-[500px] overflow-y-auto pr-1">
          {loading ? (
            <div className="p-12 text-center text-slate-500 text-xs flex items-center justify-center gap-2">
              <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
              <span>Connecting to realtime stream...</span>
            </div>
          ) : filteredEvents.length === 0 ? (
            <div className="p-12 text-center text-slate-500 text-xs">
              No events captured yet. Dispatch a job or burst to see live stream activity!
            </div>
          ) : (
            filteredEvents.map((ev, index) => {
              const eventType = ev.type || ev.event_type || 'SYSTEM_EVENT';
              const isError = eventType.includes('FAIL') || eventType.includes('DLQ') || eventType.includes('ERROR');
              const isSuccess = eventType.includes('SUCCESS') || eventType.includes('COMPLETE');
              const isWorker = eventType.includes('WORKER') || eventType.includes('AUTOSCALE');
              const jobId = ev.jobId || ev.job_id || ev.data?.jobId;

              return (
                <div
                  key={ev.id || index}
                  className={`p-3.5 rounded-xl border transition-all text-xs ${
                    isError
                      ? 'bg-rose-950/20 border-rose-800/40 text-rose-200'
                      : isSuccess
                      ? 'bg-emerald-950/20 border-emerald-800/40 text-emerald-200'
                      : isWorker
                      ? 'bg-indigo-950/20 border-indigo-800/40 text-indigo-200'
                      : 'bg-slate-950/60 border-slate-800/80 text-slate-200'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 mb-1.5">
                    <div className="flex items-center gap-2">
                      <span className={`px-2 py-0.5 rounded font-mono text-[10px] font-bold uppercase ${
                        isError
                          ? 'bg-rose-500/20 text-rose-300'
                          : isSuccess
                          ? 'bg-emerald-500/20 text-emerald-300'
                          : isWorker
                          ? 'bg-indigo-500/20 text-indigo-300'
                          : 'bg-slate-800 text-slate-300'
                      }`}>
                        {eventType}
                      </span>
                      {ev.message && <span className="font-semibold text-slate-100">{ev.message}</span>}
                    </div>

                    <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500">
                      <span>{ev.timestamp ? new Date(ev.timestamp).toLocaleTimeString() : 'now'}</span>
                      {jobId && (
                        <button
                          onClick={() => onViewJob?.(jobId)}
                          className="flex items-center gap-1 text-indigo-400 hover:text-indigo-300 transition-colors"
                        >
                          <span>Inspect Job</span>
                          <ArrowUpRight className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </div>

                  {(ev.data || ev.payload) && (
                    <pre className="p-2 rounded-lg bg-slate-950/90 text-slate-400 font-mono text-[11px] overflow-x-auto border border-slate-800/60">
                      {JSON.stringify(ev.data || ev.payload, null, 2)}
                    </pre>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
};
