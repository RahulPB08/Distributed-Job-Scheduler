import React, { useEffect, useState, useCallback } from 'react';
import { RotateCw, Trash2, RefreshCw, Skull, Sparkles, AlertTriangle, CheckCircle2, ArrowUpRight, Search, ShieldCheck } from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';

export const DeadLetterQueue = ({ onViewJob }) => {
  const { currentProject } = useProject();
  const { lastEvent } = useWebSocket();
  const [entries, setEntries] = useState([]);
  const [selectedIds, setSelectedIds] = useState([]);
  const [selectedEntry, setSelectedEntry] = useState(null);
  const [diagnosticResult, setDiagnosticResult] = useState(null);
  const [diagnosing, setDiagnosing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchDlq = useCallback(async () => {
    try {
      setIsRefreshing(true);
      const res = await api.dlq.list({ projectId: currentProject?.id });
      setEntries(res?.data?.entries || res?.data?.data?.entries || (Array.isArray(res?.data) ? res.data : []));
    } catch (err) {
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [currentProject?.id]);

  useEffect(() => {
    fetchDlq();
    const interval = setInterval(fetchDlq, 3000);
    return () => clearInterval(interval);
  }, [fetchDlq]);

  useEffect(() => {
    if (lastEvent && (lastEvent.type?.includes('DLQ') || lastEvent.type?.includes('FAIL') || lastEvent.type?.includes('JOB'))) {
      fetchDlq();
    }
  }, [lastEvent, fetchDlq]);

  const handleSelectAll = (e) => {
    if (e.target.checked) {
      setSelectedIds(entries.filter((e) => e.resolution_status === 'unresolved').map((e) => e.id));
    } else {
      setSelectedIds([]);
    }
  };

  const handleSelectOne = (id) => {
    if (selectedIds.includes(id)) {
      setSelectedIds(selectedIds.filter((item) => item !== id));
    } else {
      setSelectedIds([...selectedIds, id]);
    }
  };

  const handleRetrySingle = async (e, id) => {
    e.stopPropagation();
    try {
      await api.dlq.retry(id);
      fetchDlq();
    } catch (err) {}
  };

  const handleBulkRetry = async () => {
    if (selectedIds.length === 0) return;
    try {
      await api.dlq.bulkRetry(selectedIds);
      setSelectedIds([]);
      fetchDlq();
    } catch (err) {}
  };

  const handlePurge = async (e, id) => {
    e.stopPropagation();
    try {
      await api.dlq.purge(id);
      fetchDlq();
    } catch (err) {}
  };

  const handleDiagnose = async (entry) => {
    setSelectedEntry(entry);
    setDiagnosticResult(entry.ai_diagnostic_summary || null);
    setDiagnosing(true);
    try {
      const res = await api.dlq.diagnose(entry.id);
      setDiagnosticResult(res.data);
    } catch (err) {
    } finally {
      setDiagnosing(false);
    }
  };

  const unresolvedCount = entries.filter((e) => e.resolution_status === 'unresolved').length;

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400">
            <Skull className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Dead Letter Queue (DLQ) &amp; AI Diagnostics</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Exhausted retry failures, stack trace archives, automated AI root-cause analysis &amp; bulk re-queueing
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {selectedIds.length > 0 && (
            <button
              onClick={handleBulkRetry}
              className="btn-primary text-xs"
            >
              <RotateCw className="w-3.5 h-3.5" />
              <span>Requeue Selected ({selectedIds.length})</span>
            </button>
          )}
          <button
            onClick={fetchDlq}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh DLQ"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* KPI summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="glass-card p-4 space-y-1">
          <span className="text-xs text-slate-400 font-medium">Unresolved Dead Letter Jobs</span>
          <p className="text-2xl font-black text-rose-400">{unresolvedCount}</p>
        </div>
        <div className="glass-card p-4 space-y-1">
          <span className="text-xs text-slate-400 font-medium">Total DLQ Archived</span>
          <p className="text-2xl font-black text-white">{entries.length}</p>
        </div>
        <div className="glass-card p-4 space-y-1">
          <span className="text-xs text-slate-400 font-medium">AI Diagnostic Engine</span>
          <p className="text-xs font-semibold text-emerald-400 flex items-center gap-1 mt-1">
            <Sparkles className="w-3.5 h-3.5" />
            <span>Gemini Root-Cause Remediation Active</span>
          </p>
        </div>
      </div>

      {/* DLQ Table */}
      <div className="glass-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="djs-table">
            <thead>
              <tr>
                <th className="w-8">
                  <input
                    type="checkbox"
                    onChange={handleSelectAll}
                    checked={selectedIds.length > 0 && selectedIds.length === unresolvedCount && unresolvedCount > 0}
                    className="rounded border-slate-700 bg-slate-950 accent-indigo-500"
                  />
                </th>
                <th>Failed Job</th>
                <th>Service Queue</th>
                <th>Failure Classification</th>
                <th>Attempts</th>
                <th>Archived At</th>
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
                      <span>Loading DLQ archives...</span>
                    </div>
                  </td>
                </tr>
              ) : entries.length === 0 ? (
                <tr>
                  <td colSpan="8" className="py-12 text-center text-slate-500">
                    <CheckCircle2 className="w-8 h-8 text-emerald-400/50 mx-auto mb-2" />
                    <p className="text-sm text-slate-300 font-semibold">Dead Letter Queue is Empty</p>
                    <p className="text-xs text-slate-500 mt-0.5">All jobs processed successfully or are undergoing normal backoff retries.</p>
                  </td>
                </tr>
              ) : (
                entries.map((entry) => (
                  <tr key={entry.id} className="transition-all hover:bg-slate-800/40">
                    <td>
                      {entry.resolution_status === 'unresolved' && (
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(entry.id)}
                          onChange={() => handleSelectOne(entry.id)}
                          className="rounded border-slate-700 bg-slate-950 accent-indigo-500"
                        />
                      )}
                    </td>
                    <td>
                      <p className="font-semibold text-slate-100">{entry.job_name}</p>
                      <p className="text-[10px] font-mono text-slate-500">{entry.job_id}</p>
                    </td>
                    <td className="font-mono text-xs text-slate-300">{entry.queue_name}</td>
                    <td className="text-rose-300 font-mono text-[11px] max-w-xs truncate" title={entry.failure_reason}>
                      {entry.failure_reason}
                    </td>
                    <td className="font-mono text-xs text-slate-300 font-bold">{entry.retry_attempts}</td>
                    <td className="font-mono text-xs text-slate-400">
                      {new Date(entry.archived_at).toLocaleTimeString()}
                    </td>
                    <td>
                      {entry.resolution_status === 'unresolved' ? (
                        <Badge status="dlq" text="Unresolved" />
                      ) : entry.resolution_status === 'requeued' ? (
                        <Badge status="completed" text="Requeued" />
                      ) : (
                        <Badge status="cancelled" text="Purged" />
                      )}
                    </td>
                    <td className="text-right">
                      <div className="flex items-center justify-end gap-1.5">
                        <button
                          onClick={() => handleDiagnose(entry)}
                          className="btn-secondary text-[11px] py-1 px-2 gap-1 text-indigo-300"
                        >
                          <Sparkles className="w-3 h-3 text-indigo-400" />
                          <span>AI Diagnose</span>
                        </button>
                        {entry.resolution_status === 'unresolved' && (
                          <>
                            <button
                              onClick={(e) => handleRetrySingle(e, entry.id)}
                              title="Requeue Job"
                              className="p-1.5 rounded-lg text-emerald-400 hover:bg-emerald-500/10 transition-colors"
                            >
                              <RotateCw className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={(e) => handlePurge(e, entry.id)}
                              title="Purge Record"
                              className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* AI Failure Diagnostic Modal */}
      {selectedEntry && (
        <Modal
          isOpen={!!selectedEntry}
          onClose={() => {
            setSelectedEntry(null);
            setDiagnosticResult(null);
          }}
          title={`AI Failure Diagnostic: ${selectedEntry.job_name}`}
          maxWidth="max-w-3xl"
        >
          <div className="space-y-4 text-xs">
            <div className="rounded-2xl border border-indigo-500/20 bg-slate-950 p-4 space-y-3">
              <div className="flex items-center justify-between border-b border-slate-800 pb-2.5">
                <div className="flex items-center gap-2">
                  <Sparkles className="w-4 h-4 text-indigo-400" />
                  <span className="font-bold text-white text-sm">Automated Root-Cause Diagnostic</span>
                </div>
                {diagnosticResult && (
                  <span className="font-mono text-slate-400 text-[11px] bg-slate-900 px-2 py-0.5 rounded border border-slate-800">
                    Confidence: {(diagnosticResult.confidence * 100).toFixed(0)}%
                  </span>
                )}
              </div>

              {diagnosing ? (
                <div className="py-8 text-center font-mono text-slate-400 flex items-center justify-center gap-2">
                  <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                  <span>Synthesizing failure classification and remediation path...</span>
                </div>
              ) : diagnosticResult ? (
                <div className="space-y-3">
                  <div>
                    <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">Failure Classification</span>
                    <span className="text-slate-100 font-bold text-sm mt-0.5 block">{diagnosticResult.category}</span>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">Identified Root Cause</span>
                    <p className="text-slate-300 mt-1 leading-relaxed">{diagnosticResult.rootCause}</p>
                  </div>
                  <div>
                    <span className="font-semibold text-slate-400 uppercase tracking-wider text-[10px] block">Recommended Remediation Action</span>
                    <p className="text-emerald-300 mt-1 leading-relaxed">{diagnosticResult.remediation}</p>
                  </div>
                </div>
              ) : null}
            </div>

            <div>
              <h4 className="font-semibold text-slate-300 mb-1.5">Full Stack Trace</h4>
              <pre className="max-h-44 overflow-auto rounded-xl border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] text-rose-300">
                {selectedEntry.stack_trace || selectedEntry.failure_reason}
              </pre>
            </div>

            <div className="flex justify-end gap-2 pt-3 border-t border-slate-800">
              <button
                onClick={() => {
                  setSelectedEntry(null);
                  setDiagnosticResult(null);
                }}
                className="btn-ghost text-xs"
              >
                Close
              </button>
              {selectedEntry.resolution_status === 'unresolved' && (
                <button
                  onClick={async () => {
                    await api.dlq.retry(selectedEntry.id);
                    setSelectedEntry(null);
                    fetchDlq();
                  }}
                  className="btn-primary text-xs"
                >
                  <RotateCw className="w-3.5 h-3.5" />
                  <span>Requeue Job for Execution</span>
                </button>
              )}
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
};
