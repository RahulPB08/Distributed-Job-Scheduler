import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import {
  RotateCcw, Plus, Pencil, Trash2, RefreshCw,
  AlertCircle, CheckCircle, Zap, ChevronDown, ChevronUp, TrendingUp
} from 'lucide-react';

const STRATEGY_META = {
  none:                { label: 'None',         color: 'text-slate-400',   bg: 'bg-slate-400/10', desc: 'No retries. Job moves straight to DLQ on failure.' },
  fixed:               { label: 'Fixed Delay',  color: 'text-amber-300',   bg: 'bg-amber-400/10', desc: 'Retry after a constant delay each time.' },
  linear_backoff:      { label: 'Linear',       color: 'text-cyan-300',    bg: 'bg-cyan-400/10',  desc: 'Delay increases linearly: delay × attempt.' },
  exponential_backoff: { label: 'Exponential',  color: 'text-violet-300',  bg: 'bg-violet-400/10',desc: 'Delay doubles each attempt up to the max.' },
};

const PolicyCard = ({ policy, onEdit, onDelete, isExpanded, onToggle }) => {
  const meta = STRATEGY_META[policy.strategy] || STRATEGY_META.fixed;

  return (
    <div className="glass rounded-2xl overflow-hidden card-glow border border-indigo-500/15">
      <div className="p-5 flex items-center gap-4 cursor-pointer" onClick={onToggle}>
        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${meta.bg}`}>
          <RotateCcw size={18} className={meta.color} />
        </div>
        <div className="flex-1">
          <p className="font-semibold text-slate-100">{policy.name}</p>
          <div className="flex items-center gap-2 mt-0.5">
            <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${meta.bg} ${meta.color}`}>
              {meta.label}
            </span>
            <span className="text-xs text-slate-500">
              {policy.max_retries} retries · {policy.base_delay_seconds}s base delay
            </span>
            {policy.jobs_using > 0 && (
              <span className="text-xs text-indigo-400 ml-auto mr-4">{policy.jobs_using} jobs using this</span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={(e) => { e.stopPropagation(); onEdit(policy); }} className="btn-secondary py-1.5 px-3 text-xs">
            <Pencil size={12} /> Edit
          </button>
          <button onClick={(e) => { e.stopPropagation(); onDelete(policy); }} className="btn-danger py-1.5 px-3 text-xs">
            <Trash2 size={12} />
          </button>
          {isExpanded ? <ChevronUp size={16} className="text-slate-500" /> : <ChevronDown size={16} className="text-slate-500" />}
        </div>
      </div>

      {isExpanded && (
        <div className="border-t border-indigo-500/10 px-5 py-4 grid grid-cols-2 sm:grid-cols-4 gap-4 bg-indigo-950/20">
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Strategy</p>
            <p className={`text-sm font-semibold ${meta.color}`}>{meta.label}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Max Retries</p>
            <p className="text-sm font-semibold text-slate-200">{policy.max_retries}</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Base Delay</p>
            <p className="text-sm font-semibold text-slate-200">{policy.base_delay_seconds}s</p>
          </div>
          <div>
            <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Max Delay</p>
            <p className="text-sm font-semibold text-slate-200">{policy.max_delay_seconds}s</p>
          </div>
          {policy.strategy !== 'none' && policy.strategy !== 'fixed' && (
            <div className="col-span-full">
              <p className="text-xs text-slate-500 uppercase tracking-wide mb-1">Backoff Multiplier</p>
              <p className="text-sm font-semibold text-slate-200">×{policy.backoff_multiplier}</p>
            </div>
          )}
          <div className="col-span-full">
            <p className="text-xs text-slate-500 mt-1">{meta.desc}</p>
          </div>
        </div>
      )}
    </div>
  );
};

const defaultForm = { name: '', strategy: 'exponential_backoff', maxRetries: 3, baseDelaySeconds: 5, maxDelaySeconds: 300, backoffMultiplier: 2.0 };

export const RetryPolicies = () => {
  const { currentProject: selectedProject } = useProject();
  const [policies, setPolicies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);
  const [expanded, setExpanded] = useState(null);
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(defaultForm);
  const [saving, setSaving] = useState(false);

  const projectId = selectedProject?.id;

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchPolicies = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const res = await api.retryPolicies.listForProject(projectId);
      setPolicies(res.data || []);
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => { fetchPolicies(); }, [fetchPolicies]);

  const handleEdit = (policy) => {
    setForm({
      name: policy.name,
      strategy: policy.strategy,
      maxRetries: policy.max_retries,
      baseDelaySeconds: policy.base_delay_seconds,
      maxDelaySeconds: policy.max_delay_seconds,
      backoffMultiplier: policy.backoff_multiplier,
    });
    setEditingId(policy.id);
    setShowForm(true);
  };

  const handleDelete = async (policy) => {
    if (!window.confirm(`Delete retry policy "${policy.name}"?`)) return;
    try {
      await api.retryPolicies.delete(policy.id);
      showToast('Policy deleted');
      fetchPolicies();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setSaving(true);
    try {
      if (editingId) {
        await api.retryPolicies.update(editingId, form);
        showToast('Policy updated');
      } else {
        await api.retryPolicies.create(projectId, form);
        showToast('Policy created');
      }
      setShowForm(false);
      setEditingId(null);
      setForm(defaultForm);
      fetchPolicies();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  if (!projectId) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-500">
        <RotateCcw size={40} className="mb-3 opacity-40" />
        <p>Select a project to manage retry policies.</p>
      </div>
    );
  }

  return (
    <div className="space-y-6 animate-fade-in-up">
      {toast && (
        <div className={`fixed top-5 right-5 z-50 flex items-center gap-2 px-4 py-3 rounded-xl text-sm font-medium shadow-2xl animate-slide-right
          ${toast.type === 'error' ? 'bg-rose-500/20 border border-rose-500/40 text-rose-300' : 'bg-emerald-500/20 border border-emerald-500/40 text-emerald-300'}`}>
          {toast.type === 'error' ? <AlertCircle size={16} /> : <CheckCircle size={16} />}
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="section-header gradient-text">Retry Policies</h1>
          <p className="section-sub">Define reusable failure-handling strategies for <strong className="text-slate-300">{selectedProject?.name}</strong></p>
        </div>
        <div className="flex gap-2">
          <button onClick={fetchPolicies} className="btn-secondary">
            <RefreshCw size={14} /> Refresh
          </button>
          <button onClick={() => { setForm(defaultForm); setEditingId(null); setShowForm(true); }} className="btn-primary">
            <Plus size={14} /> New Policy
          </button>
        </div>
      </div>

      {/* Strategy overview */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {Object.entries(STRATEGY_META).map(([k, v]) => (
          <div key={k} className={`rounded-xl p-4 ${v.bg} border border-white/5`}>
            <p className={`text-sm font-semibold ${v.color}`}>{v.label}</p>
            <p className="text-xs text-slate-500 mt-1 leading-relaxed">{v.desc}</p>
          </div>
        ))}
      </div>

      {/* Create / Edit form */}
      {showForm && (
        <div className="glass-bright rounded-2xl p-6 animate-fade-in">
          <h2 className="font-semibold text-slate-200 mb-4">{editingId ? 'Edit Policy' : 'New Retry Policy'}</h2>
          <form onSubmit={handleSave} className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Policy Name</label>
                <input className="djs-input" placeholder="e.g. Aggressive Exponential" value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))} required />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Strategy</label>
                <select className="djs-input" value={form.strategy} onChange={e => setForm(f => ({ ...f, strategy: e.target.value }))}>
                  <option value="none">None (no retries)</option>
                  <option value="fixed">Fixed Delay</option>
                  <option value="linear_backoff">Linear Backoff</option>
                  <option value="exponential_backoff">Exponential Backoff</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Max Retries</label>
                <input type="number" min="0" max="20" className="djs-input" value={form.maxRetries}
                  onChange={e => setForm(f => ({ ...f, maxRetries: parseInt(e.target.value) || 0 }))} />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Base Delay (seconds)</label>
                <input type="number" min="1" className="djs-input" value={form.baseDelaySeconds}
                  onChange={e => setForm(f => ({ ...f, baseDelaySeconds: parseInt(e.target.value) || 5 }))} />
              </div>
              <div>
                <label className="text-xs text-slate-400 mb-1.5 block">Max Delay (seconds)</label>
                <input type="number" min="1" className="djs-input" value={form.maxDelaySeconds}
                  onChange={e => setForm(f => ({ ...f, maxDelaySeconds: parseInt(e.target.value) || 300 }))} />
              </div>
              {(form.strategy === 'exponential_backoff' || form.strategy === 'linear_backoff') && (
                <div>
                  <label className="text-xs text-slate-400 mb-1.5 block">Backoff Multiplier</label>
                  <input type="number" min="1" step="0.1" className="djs-input" value={form.backoffMultiplier}
                    onChange={e => setForm(f => ({ ...f, backoffMultiplier: parseFloat(e.target.value) || 2 }))} />
                </div>
              )}
            </div>
            <div className="flex gap-2 pt-2">
              <button type="submit" disabled={saving} className="btn-primary">
                {saving ? <RefreshCw size={14} className="animate-spin" /> : <CheckCircle size={14} />}
                {saving ? 'Saving...' : editingId ? 'Update Policy' : 'Create Policy'}
              </button>
              <button type="button" onClick={() => setShowForm(false)} className="btn-secondary">Cancel</button>
            </div>
          </form>
        </div>
      )}

      {/* Policies list */}
      {loading ? (
        <div className="space-y-3">
          {[1,2,3].map(i => <div key={i} className="skeleton h-20 rounded-2xl" />)}
        </div>
      ) : policies.length === 0 ? (
        <div className="glass rounded-2xl p-12 text-center">
          <TrendingUp size={40} className="mx-auto mb-3 text-slate-600" />
          <p className="text-slate-400">No retry policies yet. Create one to define how jobs handle failures.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {policies.map(p => (
            <PolicyCard
              key={p.id}
              policy={p}
              onEdit={handleEdit}
              onDelete={handleDelete}
              isExpanded={expanded === p.id}
              onToggle={() => setExpanded(expanded === p.id ? null : p.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
};
