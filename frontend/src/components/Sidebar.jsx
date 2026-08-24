import React from 'react';
import {
  LayoutDashboard, Layers, BriefcaseBusiness, Calendar, Radio,
  Server, Skull, GitBranch, BarChart3, FolderKanban,
  Users, ChevronRight, Zap, Clock, Play
} from 'lucide-react';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { useProject } from '../context/ProjectContext.jsx';

const NAV_ITEMS = [
  {
    group: 'Overview',
    items: [
      { id: 'overview', label: 'Dashboard',    icon: LayoutDashboard, color: 'text-indigo-400',  dot: 'bg-indigo-400' },
    ]
  },
  {
    group: 'Jobs',
    items: [
      { id: 'jobs',      label: 'Job Explorer',  icon: Play,               color: 'text-cyan-400',    dot: 'bg-cyan-400' },
      { id: 'batches',   label: 'Batch Manager', icon: BriefcaseBusiness,  color: 'text-violet-400',  dot: 'bg-violet-400' },
      { id: 'schedules', label: 'Scheduler',     icon: Calendar,           color: 'text-amber-400',   dot: 'bg-amber-400' },
    ]
  },
  {
    group: 'Infrastructure',
    items: [
      { id: 'queues',   label: 'Queue Manager',  icon: Layers,      color: 'text-blue-400',    dot: 'bg-blue-400' },
      { id: 'workers',  label: 'Worker Fleet',   icon: Server,      color: 'text-emerald-400', dot: 'bg-emerald-400' },
      { id: 'dag',      label: 'Workflow DAG',   icon: GitBranch,   color: 'text-pink-400',    dot: 'bg-pink-400' },
    ]
  },
  {
    group: 'Monitoring',
    items: [
      { id: 'metrics', label: 'Metrics',         icon: BarChart3,   color: 'text-cyan-400',    dot: 'bg-cyan-400' },
      { id: 'events',  label: 'Event Stream',    icon: Radio,       color: 'text-indigo-400',  dot: 'bg-indigo-400' },
      { id: 'dlq',     label: 'Dead Letter Q',   icon: Skull,       color: 'text-rose-400',    dot: 'bg-rose-400' },
    ]
  },
  {
    group: 'Admin',
    items: [
      { id: 'projects', label: 'Projects',       icon: FolderKanban, color: 'text-slate-400',  dot: 'bg-slate-400' },
      { id: 'members',  label: 'Members',        icon: Users,        color: 'text-slate-400',  dot: 'bg-slate-400' },
    ]
  },
];

export const Sidebar = ({ activeTab, setActiveTab }) => {
  const { isConnected, lastEvent } = useWebSocket();
  const { currentProject } = useProject();

  return (
    <aside className="w-60 shrink-0 flex flex-col border-r" style={{ 
      background: 'linear-gradient(180deg, var(--surface-0) 0%, var(--surface-1) 100%)',
      borderColor: 'var(--border)',
      height: 'calc(100vh - 57px)',
      position: 'sticky',
      top: '57px',
      overflowY: 'auto'
    }}>
      {/* Project indicator */}
      {currentProject && (
        <div className="px-4 py-3 border-b" style={{ borderColor: 'var(--border)' }}>
          <div className="flex items-center gap-2.5 px-3 py-2 rounded-xl" style={{ background: 'rgba(99,102,241,0.08)', border: '1px solid rgba(99,102,241,0.15)' }}>
            <div className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            <div className="min-w-0">
              <p className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold">Active Project</p>
              <p className="text-xs font-semibold text-indigo-300 truncate">{currentProject.name}</p>
            </div>
          </div>
        </div>
      )}

      {/* Nav groups */}
      <nav className="flex-1 p-3 space-y-5">
        {NAV_ITEMS.map(({ group, items }) => (
          <div key={group}>
            <p className="px-3 pb-1.5 text-[10px] font-bold uppercase tracking-widest text-slate-600">{group}</p>
            <div className="space-y-0.5">
              {items.map(({ id, label, icon: Icon, color, dot }) => {
                const isActive = activeTab === id;
                return (
                  <button
                    key={id}
                    onClick={() => setActiveTab(id)}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-150 group relative ${
                      isActive
                        ? 'text-white'
                        : 'text-slate-400 hover:text-slate-200 hover:bg-white/3'
                    }`}
                    style={isActive ? {
                      background: 'linear-gradient(135deg, rgba(99,102,241,0.18), rgba(139,92,246,0.12))',
                      border: '1px solid rgba(99,102,241,0.2)',
                    } : {}}
                  >
                    {isActive && (
                      <div className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-indigo-400" />
                    )}
                    <Icon className={`w-4 h-4 shrink-0 ${isActive ? color : 'text-slate-500 group-hover:text-slate-400'} transition-colors`} />
                    <span className="flex-1 text-left">{label}</span>
                    {isActive && (
                      <ChevronRight className={`w-3.5 h-3.5 ${color}`} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </nav>

      {/* WS Status footer */}
      <div className="p-3 border-t" style={{ borderColor: 'var(--border)' }}>
        <div className={`flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-xs font-medium ${
          isConnected
            ? 'bg-emerald-500/8 border border-emerald-500/15 text-emerald-400'
            : 'bg-slate-800/50 border border-slate-700/50 text-slate-500'
        }`}>
          <div className={`w-2 h-2 rounded-full ${isConnected ? 'bg-emerald-400' : 'bg-slate-600'}`} style={isConnected ? { animation: 'pulse-dot 2s infinite' } : {}} />
          <div className="flex-1 min-w-0">
            <p className="font-semibold">{isConnected ? 'Live Connected' : 'Disconnected'}</p>
            {lastEvent && isConnected && (
              <p className="text-[10px] truncate opacity-70">
                {lastEvent.type?.replace(/_/g, ' ')}
              </p>
            )}
          </div>
          {isConnected && <Zap className="w-3 h-3 shrink-0 opacity-60" />}
        </div>
      </div>
    </aside>
  );
};
