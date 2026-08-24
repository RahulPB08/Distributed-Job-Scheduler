import React, { useState, useEffect, useRef } from 'react';
import {
  Terminal,
  Play,
  Pause,
  Trash2,
  Copy,
  Check,
  Filter,
  Activity,
  Cpu,
  Server,
  Zap,
  CheckCircle2,
  AlertCircle
} from 'lucide-react';
import { useWebSocket } from '../context/WebSocketContext.jsx';

export const LiveCheckpointTerminal = ({ title = 'Live Worker & System Checkpoint Terminal', maxHeight = '420px' }) => {
  const { isConnected, eventHistory } = useWebSocket();
  const [filter, setFilter] = useState('all'); // 'all', 'checkpoints', 'executions', 'heartbeats'
  const [isAutoScroll, setIsAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [clearedBeforeTimestamp, setClearedBeforeTimestamp] = useState(null);
  const containerRef = useRef(null);

  useEffect(() => {
    if (isAutoScroll && containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [eventHistory, isAutoScroll]);

  const handleCopyLogs = () => {
    const text = filteredEvents.map(e => `[${e.timestamp}] [${e.type}] ${e.message || ''} ${JSON.stringify(e.data || {})}`).join('\n');
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleClearLogs = () => {
    setClearedBeforeTimestamp(Date.now());
  };

  const filteredEvents = eventHistory
    .filter(event => {
      if (clearedBeforeTimestamp && event.timestamp && new Date(event.timestamp).getTime() <= clearedBeforeTimestamp) {
        return false;
      }
      if (filter === 'all') return true;
      const typeUpper = (event.type || '').toUpperCase();
      if (filter === 'checkpoints') {
        return typeUpper.includes('CHECKPOINT') || typeUpper.includes('DISCOVERY') || typeUpper.includes('CLAIM') || typeUpper.includes('STARTUP') || typeUpper.includes('REGISTRATION');
      }
      if (filter === 'executions') {
        return typeUpper.includes('JOB_') || typeUpper.includes('EXECUTION') || typeUpper.includes('DAG') || typeUpper.includes('LOG') || typeUpper.includes('TASK');
      }
      if (filter === 'heartbeats') {
        return typeUpper.includes('HEARTBEAT') || typeUpper.includes('WORKER') || typeUpper.includes('TELEMETRY');
      }
      return true;
    });

  const getBadgeStyle = (type = '') => {
    if (type.includes('COMPLETED') || type.includes('SUCCESS')) {
      return 'bg-emerald-950 text-emerald-400 border-emerald-800';
    }
    if (type.includes('CLAIM') || type.includes('PROMOTED')) {
      return 'bg-cyan-950 text-cyan-400 border-cyan-800';
    }
    if (type.includes('RUNNING') || type.includes('STARTED')) {
      return 'bg-blue-950 text-blue-400 border-blue-800';
    }
    if (type.includes('RETRY') || type.includes('WARN')) {
      return 'bg-amber-950 text-amber-400 border-amber-800';
    }
    if (type.includes('FAILED') || type.includes('DLQ') || type.includes('DEAD')) {
      return 'bg-rose-950 text-rose-400 border-rose-800';
    }
    if (type.includes('HEARTBEAT')) {
      return 'bg-purple-950 text-purple-400 border-purple-800';
    }
    return 'bg-slate-800 text-slate-300 border-slate-700';
  };

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/90 shadow-2xl backdrop-blur-md overflow-hidden font-mono text-xs">
      {/* Terminal Header */}
      <div className="flex flex-wrap items-center justify-between border-b border-slate-800/80 bg-slate-900/90 px-4 py-2.5">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full bg-rose-500/80 inline-block"></span>
            <span className="h-2.5 w-2.5 rounded-full bg-amber-500/80 inline-block"></span>
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-500/80 inline-block"></span>
          </div>
          <div className="flex items-center gap-2 border-l border-slate-800 pl-3">
            <Terminal className="h-4 w-4 text-cyan-400" />
            <span className="font-semibold text-slate-200">{title}</span>
          </div>
          <div className="flex items-center gap-1.5 rounded-full bg-slate-950 px-2.5 py-0.5 border border-slate-800">
            <span className={`h-2 w-2 rounded-full ${isConnected ? 'bg-emerald-400 animate-pulse' : 'bg-rose-400'}`}></span>
            <span className="text-[10px] text-slate-400 font-medium">
              {isConnected ? 'LIVE WS' : 'DISCONNECTED'}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2 mt-2 sm:mt-0">
          <div className="flex items-center bg-slate-950 rounded-lg p-0.5 border border-slate-800 text-[11px]">
            {['all', 'checkpoints', 'executions', 'heartbeats'].map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`px-2 py-1 rounded capitalize transition-all ${
                  filter === tab
                    ? 'bg-blue-600/30 text-cyan-300 font-semibold border border-cyan-500/30'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <button
            onClick={() => setIsAutoScroll(!isAutoScroll)}
            className={`p-1.5 rounded border ${
              isAutoScroll
                ? 'bg-emerald-950/40 border-emerald-800 text-emerald-400'
                : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
            }`}
            title={isAutoScroll ? 'Auto-scroll enabled' : 'Auto-scroll paused'}
          >
            {isAutoScroll ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}
          </button>

          <button
            onClick={handleCopyLogs}
            className="p-1.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-slate-200 transition-all"
            title="Copy logs to clipboard"
          >
            {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
          </button>

          <button
            onClick={handleClearLogs}
            className="p-1.5 rounded bg-slate-900 border border-slate-800 text-slate-400 hover:text-rose-400 transition-all"
            title="Clear terminal logs"
          >
            <Trash2 className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Body */}
      <div
        ref={containerRef}
        className="overflow-y-auto p-4 space-y-2 bg-slate-950 select-text"
        style={{ maxHeight, minHeight: '260px' }}
      >
        {filteredEvents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-slate-500 space-y-2">
            <Zap className="h-6 w-6 text-slate-600 animate-pulse" />
            <p className="text-xs">Listening for worker checkpoints, queue scans, and execution logs...</p>
            <p className="text-[11px] text-slate-600">Start a worker node or dispatch a job to see real-time checkpoints.</p>
          </div>
        ) : (
          filteredEvents.map((evt, idx) => {
            const timeStr = evt.timestamp ? new Date(evt.timestamp).toLocaleTimeString() : new Date().toLocaleTimeString();
            const badgeClass = getBadgeStyle(evt.type);
            const dataStr = evt.data ? (typeof evt.data === 'string' ? evt.data : JSON.stringify(evt.data, null, 2)) : '';

            return (
              <div
                key={idx}
                className="group rounded-lg border border-slate-900/80 bg-slate-900/40 p-2.5 transition-all hover:border-slate-700/60 hover:bg-slate-900/80"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-slate-500">{timeStr}</span>
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold border uppercase tracking-wider ${badgeClass}`}>
                      {evt.type || 'CHECKPOINT'}
                    </span>
                    {evt.data?.workerId && (
                      <span className="text-[11px] text-purple-400 font-semibold flex items-center gap-1">
                        <Server className="h-3 w-3 inline" /> {evt.data.workerId}
                      </span>
                    )}
                  </div>
                  {evt.data?.durationMs && (
                    <span className="text-[10px] text-emerald-400 bg-emerald-950/60 px-1.5 py-0.5 rounded border border-emerald-800">
                      ⚡ {evt.data.durationMs}
                    </span>
                  )}
                </div>

                {evt.message && (
                  <p className="text-slate-200 mt-1.5 text-[11px] font-mono leading-relaxed">
                    {evt.message}
                  </p>
                )}

                {dataStr && dataStr !== '{}' && (
                  <pre className="mt-1.5 overflow-x-auto rounded bg-slate-950/80 p-2 text-[11px] text-cyan-300/90 border border-slate-800/60">
                    {dataStr}
                  </pre>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
