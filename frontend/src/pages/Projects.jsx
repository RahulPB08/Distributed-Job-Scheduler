import React, { useState, useCallback } from 'react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import {
  Folder, FolderPlus, Trash2, RefreshCw, CheckCircle,
  AlertCircle, BarChart2, ArrowRight, Building2, Sparkles, Plus, Layers
} from 'lucide-react';
import { Modal } from '../components/Modal.jsx';

export const Projects = () => {
  const { user } = useAuth();
  const {
    organizations, currentOrg, projects, currentProject,
    selectProject, createProject, refreshProjects, selectOrg
  } = useProject();

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState(null);
  const [deleting, setDeleting] = useState(null);

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const handleCreate = async (e) => {
    e.preventDefault();
    if (!name.trim()) return;
    setSaving(true);
    try {
      await createProject({
        name: name.trim(),
        description: description.trim(),
        orgId: currentOrg?.id
      });
      showToast('Project created successfully with automated service queues!');
      setShowForm(false);
      setName('');
      setDescription('');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (project) => {
    if (!window.confirm(`Delete project "${project.name}"? This will delete all associated queues and jobs.`)) return;
    setDeleting(project.id);
    try {
      await api.projects.delete(project.id);
      showToast('Project deleted');
      await refreshProjects();
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      setDeleting(null);
    }
  };

  const isOrgOwner = currentOrg && (currentOrg.creator_id === user?.id || user?.role === 'admin');

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Toast */}
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

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20 text-indigo-400">
            <Folder className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Project Workspaces</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Isolated multi-tenant execution contexts with automated dedicated service queues
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={refreshProjects}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Projects"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setShowForm(true)}
            className="btn-primary text-xs"
          >
            <FolderPlus className="w-4 h-4" />
            <span>New Project</span>
          </button>
        </div>
      </div>

      {/* Projects Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects.length === 0 ? (
          <div className="lg:col-span-3 glass-card p-12 text-center text-xs text-slate-500">
            No projects in current organization. Create one to get started.
          </div>
        ) : (
          projects.map((project) => {
            const isActive = currentProject?.id === project.id;

            return (
              <div
                key={project.id}
                onClick={() => selectProject(project)}
                className={`glass-card p-5 space-y-3.5 cursor-pointer transition-all ${
                  isActive ? 'border-indigo-500/50 shadow-lg shadow-indigo-500/10' : ''
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                      isActive ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-slate-400'
                    }`}>
                      <Folder className="w-4 h-4" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-bold text-white truncate text-sm">{project.name}</p>
                      <p className="text-[11px] font-mono text-slate-500 mt-0.5 truncate">{project.slug || project.id}</p>
                    </div>
                  </div>

                  {isActive && (
                    <span className="badge badge-scheduled text-[10px]">
                      ACTIVE
                    </span>
                  )}
                </div>

                <p className="text-xs text-slate-400 line-clamp-2 min-h-[32px]">
                  {project.description || 'Dedicated background job execution workspace.'}
                </p>

                <div className="flex items-center justify-between text-xs text-slate-500 pt-3 border-t border-slate-800/80">
                  <span className="font-mono text-[11px]">Created {new Date(project.created_at).toLocaleDateString()}</span>
                  {isOrgOwner && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(project);
                      }}
                      className="p-1.5 rounded-lg text-slate-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                      title="Delete Project"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Create Project Modal */}
      <Modal isOpen={showForm} onClose={() => setShowForm(false)} title="Create New Project Workspace" maxWidth="max-w-lg">
        <form onSubmit={handleCreate} className="space-y-4 text-xs">
          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Project Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Analytics Pipeline"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="djs-input"
            />
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Description (Optional)</label>
            <textarea
              rows={3}
              placeholder="Primary workspace for background data workflows"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              className="djs-textarea"
            />
          </div>

          <div className="p-3.5 rounded-xl bg-indigo-500/8 border border-indigo-500/20 text-xs text-indigo-300 flex items-start gap-2.5">
            <Sparkles className="w-4 h-4 shrink-0 text-indigo-400 mt-0.5" />
            <span>5 autonomous service queues (HTTP, DB, Compute, Notification, Script) with 2 baseline shards each will be provisioned automatically.</span>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" onClick={() => setShowForm(false)} className="btn-ghost text-xs">
              Cancel
            </button>
            <button type="submit" disabled={saving} className="btn-primary text-xs">
              <FolderPlus className="w-3.5 h-3.5" />
              <span>{saving ? 'Creating Project...' : 'Create Project'}</span>
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
