import React, { useEffect, useState, useCallback } from 'react';
import {
  GitBranch, ArrowRight, Plus, RefreshCw, Play, Link, Unlink,
  Layers, CheckCircle2, Clock, Activity, AlertTriangle, Zap,
  Check, HelpCircle, Shield, Globe, Cpu, Database, Bell, Terminal, Sparkles,
  ChevronRight, ArrowDownRight, Eye, CheckCircle, XCircle
} from 'lucide-react';
import { api } from '../api/endpoints.js';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from '../components/Badge.jsx';
import { Modal } from '../components/Modal.jsx';

export const WorkflowDAG = ({ onViewJob }) => {
  const { currentProject, projects } = useProject();
  const { lastEvent } = useWebSocket();
  const [edges, setEdges] = useState([]);
  const [allJobs, setAllJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [selectedNodeDetails, setSelectedNodeDetails] = useState(null);

  // Active Pipeline State
  const [activePipelineJobs, setActivePipelineJobs] = useState(null);

  // Modals
  const [isCreatePipelineOpen, setIsCreatePipelineOpen] = useState(false);
  const [isAddDependencyOpen, setIsAddDependencyOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  // Form State
  const [workflowName, setWorkflowName] = useState('Production ETL Pipeline');
  const [selectedParentId, setSelectedParentId] = useState('');
  const [selectedChildId, setSelectedChildId] = useState('');
  const [dependencyCondition, setDependencyCondition] = useState('on_success');
  const [formError, setFormError] = useState(null);

  const effectiveProjectId = currentProject?.id || (projects && projects.length > 0 ? projects[0].id : null);

  const fetchDAGData = useCallback(async () => {
    if (!effectiveProjectId) return;
    try {
      setIsRefreshing(true);
      const [dagRes, jobsRes] = await Promise.all([
        api.workflows.listDAGs(effectiveProjectId).catch(() => ({ data: { edges: [] } })),
        api.jobs.list({ projectId: effectiveProjectId, limit: 100 }).catch(() => ({ data: { jobs: [] } }))
      ]);

      const fetchedEdges = dagRes?.data?.edges || (Array.isArray(dagRes?.data) ? dagRes.data : []);
      const fetchedJobs = jobsRes?.data?.jobs || (Array.isArray(jobsRes?.data) ? jobsRes.data : []);

      setEdges(fetchedEdges);
      setAllJobs(fetchedJobs);

      // Auto-populate active pipeline from recent DAG jobs if not already set
      if (!activePipelineJobs && fetchedJobs.length >= 3) {
        const dagJobs = fetchedJobs.filter((j) => j.name?.includes('[Pipeline') || j.name?.includes('Stage '));
        if (dagJobs.length >= 3) {
          const s1 = dagJobs.find((j) => j.name?.includes('Stage 1') || j.name?.includes('Extract')) || dagJobs[0];
          const s2 = dagJobs.find((j) => j.name?.includes('Stage 2') || j.name?.includes('Transform') || j.name?.includes('Compute')) || dagJobs[1];
          const s3 = dagJobs.find((j) => j.name?.includes('Stage 3') || j.name?.includes('Notify')) || dagJobs[2];

          setActivePipelineJobs([
            { stage: 1, key: 'stage_1', id: s1.id, name: s1.name, type: s1.job_type || 'http_request', status: s1.status, icon: Globe, payload: s1.payload, duration_ms: s1.duration_ms },
            { stage: 2, key: 'stage_2', id: s2.id, name: s2.name, type: s2.job_type || 'cpu_compute', status: s2.status, icon: Cpu, payload: s2.payload, duration_ms: s2.duration_ms },
            { stage: 3, key: 'stage_3', id: s3.id, name: s3.name, type: s3.job_type || 'notification_event', status: s3.status, icon: Bell, payload: s3.payload, duration_ms: s3.duration_ms }
          ]);
        }
      } else if (activePipelineJobs) {
        // Refresh status of active pipeline
        const updated = activePipelineJobs.map((p) => {
          const live = fetchedJobs.find((j) => j.id === p.id);
          return live ? { ...p, ...live } : p;
        });
        setActivePipelineJobs(updated);
      }
    } catch (err) {
      console.error('Failed to fetch DAG data:', err);
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [effectiveProjectId, activePipelineJobs]);

  useEffect(() => {
    fetchDAGData();
    const interval = setInterval(fetchDAGData, 2000);
    return () => clearInterval(interval);
  }, [fetchDAGData]);

  useEffect(() => {
    if (lastEvent && (lastEvent.type?.startsWith('JOB_') || lastEvent.type?.startsWith('DAG_') || lastEvent.type?.startsWith('WORKFLOW_'))) {
      fetchDAGData();
    }
  }, [lastEvent, fetchDAGData]);

  const handleLaunchSamplePipeline = async () => {
    if (!effectiveProjectId) return;

    try {
      setCreating(true);
      setFormError(null);
      const pipelineTimestamp = Date.now();
      const payload = {
        projectId: effectiveProjectId,
        name: workflowName || `Pipeline-${pipelineTimestamp}`,
        nodes: [
          {
            id: 'stage_1_extract',
            name: 'Stage 1: Extract Ingestion Records',
            jobType: 'http_request',
            payload: { url: 'https://httpbin.org/get', source: 'webhook_stream', count: 100 },
            priority: 50,
            maxRetries: 3
          },
          {
            id: 'stage_2_transform',
            name: 'Stage 2: Transform & Compute Metrics',
            jobType: 'cpu_compute',
            payload: { type: 'hash_iterations', algorithm: 'sha256', iterations: 20000 },
            priority: 40,
            maxRetries: 2
          },
          {
            id: 'stage_3_notify',
            name: 'Stage 3: Dispatch Completion Event',
            jobType: 'notification_event',
            payload: { channel: 'email', recipient: 'devops@company.com', event: 'ETL_COMPLETED' },
            priority: 30,
            maxRetries: 1
          }
        ],
        edges: [
          { from: 'stage_1_extract', to: 'stage_2_transform', condition: 'on_success' },
          { from: 'stage_2_transform', to: 'stage_3_notify', condition: 'on_success' }
        ]
      };

      const res = await api.workflows.createDAG(payload);
      if (res.data?.jobMapping) {
        const mapping = res.data.jobMapping;
        const newPipeline = [
          { stage: 1, key: 'stage_1_extract', id: mapping.stage_1_extract, name: 'Stage 1: Extract Ingestion Records', type: 'http_request', status: 'queued', icon: Globe, payload: payload.nodes[0].payload },
          { stage: 2, key: 'stage_2_transform', id: mapping.stage_2_transform, name: 'Stage 2: Transform & Compute Metrics', type: 'cpu_compute', status: 'scheduled', icon: Cpu, payload: payload.nodes[1].payload },
          { stage: 3, key: 'stage_3_notify', id: mapping.stage_3_notify, name: 'Stage 3: Dispatch Completion Event', type: 'notification_event', status: 'scheduled', icon: Bell, payload: payload.nodes[2].payload }
        ];
        setActivePipelineJobs(newPipeline);
        setSelectedNodeDetails(newPipeline[0]);
      }

      setIsCreatePipelineOpen(false);
      fetchDAGData();
    } catch (err) {
      setFormError(err.message || 'Failed to dispatch workflow DAG');
    } finally {
      setCreating(false);
    }
  };

  const handleAddDependency = async (e) => {
    e.preventDefault();
    if (!selectedParentId || !selectedChildId) {
      setFormError('Please select both parent and child jobs.');
      return;
    }
    if (selectedParentId === selectedChildId) {
      setFormError('A job cannot depend on itself.');
      return;
    }

    try {
      setCreating(true);
      setFormError(null);
      await api.workflows.addDependency({
        parentJobId: selectedParentId,
        childJobId: selectedChildId,
        condition: dependencyCondition
      });
      setIsAddDependencyOpen(false);
      setSelectedParentId('');
      setSelectedChildId('');
      fetchDAGData();
    } catch (err) {
      setFormError(err.message || 'Failed to link dependency');
    } finally {
      setCreating(false);
    }
  };

  const handleRemoveDependency = async (dependencyId) => {
    if (window.confirm('Remove this workflow dependency constraint?')) {
      try {
        await api.workflows.removeDependency(dependencyId);
        fetchDAGData();
      } catch (err) {
        alert(err.message || 'Failed to remove dependency');
      }
    }
  };

  const jobsMap = new Map();
  allJobs.forEach((j) => jobsMap.set(j.id, j));

  // Compute live pipeline stats
  const completedStages = activePipelineJobs ? activePipelineJobs.filter((p) => p.status === 'completed').length : 0;
  const totalStages = activePipelineJobs ? activePipelineJobs.length : 3;
  const pipelinePercent = activePipelineJobs ? Math.round((completedStages / totalStages) * 100) : 0;

  return (
    <div className="space-y-5 animate-fade-in-up">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 glass-card p-5">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-pink-500/10 border border-pink-500/20 text-pink-400">
            <GitBranch className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Workflow Dependencies (DAG Engine)</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Visual Directed Acyclic Graph pipeline execution with deterministic parent-to-child dependencies
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchDAGData}
            disabled={isRefreshing}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh DAG Graph"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin-slow text-indigo-400' : ''}`} />
            <span>Refresh</span>
          </button>
          <button
            onClick={() => setIsAddDependencyOpen(true)}
            className="btn-secondary text-xs gap-1.5"
          >
            <Link className="w-3.5 h-3.5 text-indigo-400" />
            <span>Link Existing Jobs</span>
          </button>
          <button
            onClick={() => setIsCreatePipelineOpen(true)}
            className="btn-primary text-xs gap-1.5"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-300" />
            <span>Launch Pipeline DAG</span>
          </button>
        </div>
      </div>

      {/* Modern Interactive DAG Visualizer Canvas */}
      <div className="glass-card p-5 space-y-4 border-pink-500/20 bg-gradient-to-b from-slate-900/90 via-slate-950/80 to-slate-900/90">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <div className="p-1.5 rounded-lg bg-pink-500/20 text-pink-300">
              <GitBranch className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Interactive DAG Pipeline Visualizer</h2>
              <p className="text-xs text-slate-400">Click any stage node to inspect live payloads, execution logs, and output records</p>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-slate-900 border border-slate-800 text-xs font-mono">
              <span className="text-slate-400">Progress:</span>
              <span className="font-bold text-emerald-400">{completedStages}/{totalStages} Stages ({pipelinePercent}%)</span>
            </div>
            <button
              onClick={handleLaunchSamplePipeline}
              disabled={creating}
              className="btn-primary text-xs gap-1.5 py-1.5 px-3"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{creating ? 'Launching...' : 'Run Live 3-Stage Pipeline'}</span>
            </button>
          </div>
        </div>

        {/* Visual Flow Stages with Connecting Arrows */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
          {/* Stage 1 Node */}
          <div
            onClick={() => setSelectedNodeDetails(activePipelineJobs?.[0] || {
              stage: 1, name: 'Stage 1: Extract Ingestion Records', type: 'http_request', status: 'completed',
              payload: { url: 'https://httpbin.org/get', source: 'webhook_stream' }, duration_ms: 12
            })}
            className={`p-4 rounded-2xl border cursor-pointer transition-all hover:scale-[1.02] ${
              selectedNodeDetails?.stage === 1 ? 'ring-2 ring-indigo-500' : ''
            } ${
              activePipelineJobs?.[0]?.status === 'completed'
                ? 'bg-emerald-950/40 border-emerald-500/50 shadow-lg shadow-emerald-500/10'
                : activePipelineJobs?.[0]?.status === 'running'
                ? 'bg-indigo-950/50 border-indigo-500 shadow-lg shadow-indigo-500/20 animate-pulse'
                : 'bg-slate-950/70 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-blue-500/20 text-blue-400 flex items-center justify-center font-bold text-xs border border-blue-500/30">1</span>
                <span className="text-[11px] font-bold text-blue-400 uppercase tracking-wider">HTTP Ingestion</span>
              </div>
              <Badge status={activePipelineJobs?.[0]?.status || 'completed'} />
            </div>
            <h3 className="font-bold text-slate-100 text-xs">
              {activePipelineJobs?.[0]?.name || 'Stage 1: Extract Ingestion Records'}
            </h3>
            <p className="text-[11px] text-slate-400 mt-1">
              Fetches inbound records via HTTP service queue
            </p>
            <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-500 font-mono">
              <span>Root Node (Triggers First)</span>
              <span className="text-indigo-400 font-semibold flex items-center gap-1">
                Inspect <ChevronRight className="w-3 h-3" />
              </span>
            </div>
          </div>

          {/* Stage 2 Node */}
          <div
            onClick={() => setSelectedNodeDetails(activePipelineJobs?.[1] || {
              stage: 2, name: 'Stage 2: Transform & Compute Metrics', type: 'cpu_compute', status: 'running',
              payload: { type: 'hash_iterations', algorithm: 'sha256', iterations: 20000 }, duration_ms: 25
            })}
            className={`p-4 rounded-2xl border cursor-pointer transition-all hover:scale-[1.02] ${
              selectedNodeDetails?.stage === 2 ? 'ring-2 ring-cyan-500' : ''
            } ${
              activePipelineJobs?.[1]?.status === 'completed'
                ? 'bg-emerald-950/40 border-emerald-500/50 shadow-lg shadow-emerald-500/10'
                : activePipelineJobs?.[1]?.status === 'running'
                ? 'bg-cyan-950/50 border-cyan-500 shadow-lg shadow-cyan-500/20 animate-pulse'
                : activePipelineJobs?.[1]?.status === 'queued'
                ? 'bg-blue-950/40 border-blue-500/50'
                : 'bg-slate-950/70 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-amber-500/20 text-amber-400 flex items-center justify-center font-bold text-xs border border-amber-500/30">2</span>
                <span className="text-[11px] font-bold text-amber-400 uppercase tracking-wider">CPU Compute</span>
              </div>
              <Badge status={activePipelineJobs?.[1]?.status || (activePipelineJobs ? 'scheduled' : 'running')} />
            </div>
            <h3 className="font-bold text-slate-100 text-xs">
              {activePipelineJobs?.[1]?.name || 'Stage 2: Transform & Compute Metrics'}
            </h3>
            <p className="text-[11px] text-slate-400 mt-1">
              Waits for Stage 1 &#8594; Calculates aggregations
            </p>
            <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-500 font-mono">
              <span className="text-emerald-400 font-semibold">ON SUCCESS &#8594;</span>
              <span className="text-indigo-400 font-semibold flex items-center gap-1">
                Inspect <ChevronRight className="w-3 h-3" />
              </span>
            </div>
          </div>

          {/* Stage 3 Node */}
          <div
            onClick={() => setSelectedNodeDetails(activePipelineJobs?.[2] || {
              stage: 3, name: 'Stage 3: Dispatch Completion Event', type: 'notification_event', status: 'scheduled',
              payload: { channel: 'email', recipient: 'devops@company.com', event: 'ETL_COMPLETED' }, duration_ms: 8
            })}
            className={`p-4 rounded-2xl border cursor-pointer transition-all hover:scale-[1.02] ${
              selectedNodeDetails?.stage === 3 ? 'ring-2 ring-purple-500' : ''
            } ${
              activePipelineJobs?.[2]?.status === 'completed'
                ? 'bg-emerald-950/40 border-emerald-500/50 shadow-lg shadow-emerald-500/10'
                : activePipelineJobs?.[2]?.status === 'running'
                ? 'bg-purple-950/50 border-purple-500 shadow-lg shadow-purple-500/20 animate-pulse'
                : 'bg-slate-950/70 border-slate-800'
            }`}
          >
            <div className="flex items-center justify-between mb-2.5">
              <div className="flex items-center gap-2">
                <span className="w-6 h-6 rounded-lg bg-purple-500/20 text-purple-400 flex items-center justify-center font-bold text-xs border border-purple-500/30">3</span>
                <span className="text-[11px] font-bold text-purple-400 uppercase tracking-wider">Notification Alert</span>
              </div>
              <Badge status={activePipelineJobs?.[2]?.status || (activePipelineJobs ? 'scheduled' : 'scheduled')} />
            </div>
            <h3 className="font-bold text-slate-100 text-xs">
              {activePipelineJobs?.[2]?.name || 'Stage 3: Dispatch Completion Event'}
            </h3>
            <p className="text-[11px] text-slate-400 mt-1">
              Waits for Stage 2 &#8594; Emits alert to operators
            </p>
            <div className="mt-3 pt-2.5 border-t border-slate-800/80 flex items-center justify-between text-[10px] text-slate-500 font-mono">
              <span className="text-emerald-400 font-semibold">ON SUCCESS &#8594;</span>
              <span className="text-indigo-400 font-semibold flex items-center gap-1">
                Inspect <ChevronRight className="w-3 h-3" />
              </span>
            </div>
          </div>
        </div>

        {/* Selected Node Details Drawer */}
        {selectedNodeDetails && (
          <div className="p-4 rounded-xl bg-slate-950/90 border border-slate-800 space-y-3 text-xs">
            <div className="flex items-center justify-between pb-2 border-b border-slate-800">
              <div className="flex items-center gap-2">
                <Eye className="w-4 h-4 text-indigo-400" />
                <span className="font-bold text-white">Stage Inspector: {selectedNodeDetails.name}</span>
              </div>
              <div className="flex items-center gap-2">
                <Badge status={selectedNodeDetails.status} />
                {selectedNodeDetails.id && (
                  <button
                    onClick={() => onViewJob?.(selectedNodeDetails.id)}
                    className="btn-primary text-[11px] py-1 px-2"
                  >
                    View Job Logs &rarr;
                  </button>
                )}
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3 font-mono text-[11px]">
              <div>
                <span className="text-slate-500 block mb-1">Execution Payload:</span>
                <pre className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-cyan-300 overflow-x-auto max-h-36">
                  {JSON.stringify(selectedNodeDetails.payload || {}, null, 2)}
                </pre>
              </div>
              <div>
                <span className="text-slate-500 block mb-1">Execution Telemetry:</span>
                <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 space-y-1.5 text-slate-300">
                  <div className="flex justify-between">
                    <span className="text-slate-500">Job ID:</span>
                    <span className="text-slate-200">{selectedNodeDetails.id || 'N/A'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Service Type:</span>
                    <span className="text-indigo-400">{selectedNodeDetails.type}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-slate-500">Trigger Constraint:</span>
                    <span className="text-emerald-400 font-bold">ON_SUCCESS</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* DAG Dependency Edges Table */}
      <div className="glass-card p-5 space-y-4">
        <div className="flex items-center justify-between pb-3 border-b border-slate-800">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-pink-400 animate-pulse" />
            <span className="font-bold text-white text-sm">All Configured DAG Dependency Links</span>
          </div>
          <span className="font-mono text-xs text-slate-500">{edges.length} active edge constraints</span>
        </div>

        {loading ? (
          <div className="p-10 text-center text-xs text-slate-500 flex items-center justify-center gap-2">
            <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
            <span>Evaluating DAG graph constraints...</span>
          </div>
        ) : edges.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <GitBranch className="w-8 h-8 text-slate-600 mx-auto" />
            <div>
              <h3 className="text-sm font-bold text-slate-200">No DAG Dependencies Active</h3>
              <p className="text-xs text-slate-400 max-w-md mx-auto mt-0.5">
                Click "Run Live 3-Stage Pipeline" or "Link Existing Jobs" above to create multi-stage DAG execution pipelines.
              </p>
            </div>
          </div>
        ) : (
          <div className="space-y-2.5 max-h-96 overflow-y-auto pr-1">
            {edges.map((edge) => {
              const parent = jobsMap.get(edge.parent_job_id) || { id: edge.parent_job_id, name: edge.parent_name || 'Parent Job', status: edge.parent_status || 'completed' };
              const child = jobsMap.get(edge.child_job_id) || { id: edge.child_job_id, name: edge.child_name || 'Child Job', status: edge.child_status || 'scheduled' };

              return (
                <div
                  key={edge.id || `${edge.parent_job_id}-${edge.child_job_id}`}
                  className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 rounded-xl bg-slate-950/60 border border-slate-800 text-xs hover:border-slate-700 transition"
                >
                  {/* Upstream Parent Node */}
                  <div
                    onClick={() => onViewJob?.(parent.id)}
                    className="flex-1 p-3 rounded-lg bg-slate-900/90 border border-slate-800 cursor-pointer hover:border-slate-700 transition space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase text-indigo-400 tracking-wider">Parent (Stage 1)</span>
                      <Badge status={parent.status} />
                    </div>
                    <p className="font-bold text-slate-100 truncate">{parent.name}</p>
                    <p className="font-mono text-[10px] text-slate-500 truncate">{parent.id}</p>
                  </div>

                  {/* Flow Edge Connector */}
                  <div className="flex flex-col items-center justify-center shrink-0 px-2 space-y-0.5">
                    <span className={`px-2 py-0.5 rounded text-[9px] font-bold font-mono uppercase ${
                      edge.condition === 'on_success'
                        ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                        : 'bg-rose-500/15 text-rose-300 border border-rose-500/30'
                    }`}>
                      {edge.condition === 'on_success' ? 'ON SUCCESS →' : 'ON FAILURE →'}
                    </span>
                    <ArrowRight className="w-3.5 h-3.5 text-indigo-400" />
                  </div>

                  {/* Downstream Child Node */}
                  <div
                    onClick={() => onViewJob?.(child.id)}
                    className="flex-1 p-3 rounded-lg bg-slate-900/90 border border-slate-800 cursor-pointer hover:border-slate-700 transition space-y-1"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-[10px] font-semibold uppercase text-pink-400 tracking-wider">Downstream Child</span>
                      <Badge status={child.status} />
                    </div>
                    <p className="font-bold text-slate-100 truncate">{child.name}</p>
                    <p className="font-mono text-[10px] text-slate-500 truncate">{child.id}</p>
                  </div>

                  {/* Unlink Action */}
                  <div className="flex items-center justify-end sm:justify-center shrink-0">
                    <button
                      onClick={() => handleRemoveDependency(edge.id || edge.dependency_id || edge.child_job_id)}
                      title="Unlink Dependency"
                      className="p-2 rounded-xl text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                    >
                      <Unlink className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Launch Pipeline Modal */}
      <Modal isOpen={isCreatePipelineOpen} onClose={() => setIsCreatePipelineOpen(false)} title="Launch 3-Stage Pipeline DAG" maxWidth="max-w-lg">
        <div className="space-y-4 text-xs">
          {formError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
              {formError}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Workflow Pipeline Name</label>
            <input
              type="text"
              required
              value={workflowName}
              onChange={(e) => setWorkflowName(e.target.value)}
              className="djs-input"
            />
          </div>

          <div className="p-3.5 rounded-xl bg-slate-950 border border-slate-800 space-y-2">
            <span className="font-semibold text-indigo-300 block">3 Automated Stages Created:</span>
            <div className="space-y-1.5 font-mono text-[11px] text-slate-300">
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-[10px] text-indigo-300">1</span>
                <span>Extract Ingestion Webhook (HTTP Service)</span>
              </div>
              <div className="flex items-center gap-2 pl-2 text-slate-500">
                &darr; on_success
              </div>
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-[10px] text-indigo-300">2</span>
                <span>Compute Metrics Aggregation (CPU Compute)</span>
              </div>
              <div className="flex items-center gap-2 pl-2 text-slate-500">
                &darr; on_success
              </div>
              <div className="flex items-center gap-2">
                <span className="w-5 h-5 rounded-full bg-indigo-500/20 border border-indigo-500/30 flex items-center justify-center text-[10px] text-indigo-300">3</span>
                <span>Dispatch Completion Event (Notification)</span>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" onClick={() => setIsCreatePipelineOpen(false)} className="btn-ghost text-xs">
              Cancel
            </button>
            <button
              type="button"
              onClick={handleLaunchSamplePipeline}
              disabled={creating}
              className="btn-primary text-xs"
            >
              <Play className="w-3.5 h-3.5" />
              <span>{creating ? 'Launching Stages...' : 'Launch Workflow'}</span>
            </button>
          </div>
        </div>
      </Modal>

      {/* Link Existing Jobs Modal */}
      <Modal isOpen={isAddDependencyOpen} onClose={() => setIsAddDependencyOpen(false)} title="Link Workflow Dependency Edge" maxWidth="max-w-lg">
        <form onSubmit={handleAddDependency} className="space-y-4 text-xs">
          {formError && (
            <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-300">
              {formError}
            </div>
          )}

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Parent Job (Must complete first)</label>
            <select
              value={selectedParentId}
              onChange={(e) => setSelectedParentId(e.target.value)}
              className="djs-select"
              required
            >
              <option value="">Select Parent Job...</option>
              {allJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name} ({j.status})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Trigger Condition</label>
            <select
              value={dependencyCondition}
              onChange={(e) => setDependencyCondition(e.target.value)}
              className="djs-select"
            >
              <option value="on_success">On Success (Unlock when parent completes)</option>
              <option value="on_failure">On Failure (Unlock if parent fails/DLQs)</option>
            </select>
          </div>

          <div>
            <label className="block font-semibold text-slate-300 mb-1.5">Downstream Child Job (Waits for parent)</label>
            <select
              value={selectedChildId}
              onChange={(e) => setSelectedChildId(e.target.value)}
              className="djs-select"
              required
            >
              <option value="">Select Child Job...</option>
              {allJobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.name} ({j.status})
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button type="button" onClick={() => setIsAddDependencyOpen(false)} className="btn-ghost text-xs">
              Cancel
            </button>
            <button type="submit" disabled={creating} className="btn-primary text-xs">
              <Link className="w-3.5 h-3.5" />
              <span>{creating ? 'Linking...' : 'Add Dependency Constraint'}</span>
            </button>
          </div>
        </form>
      </Modal>
    </div>
  );
};
