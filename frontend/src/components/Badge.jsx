import React from 'react';

const statusStyles = {
  scheduled: 'bg-slate-800 text-slate-300 border-slate-700',
  queued: 'bg-amber-950/40 text-amber-300 border-amber-800/50',
  claimed: 'bg-sky-950/40 text-sky-300 border-sky-800/50',
  running: 'bg-blue-950/40 text-blue-300 border-blue-800/50',
  completed: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50',
  failed: 'bg-rose-950/40 text-rose-300 border-rose-800/50',
  dlq: 'bg-purple-950/40 text-purple-300 border-purple-800/50',
  cancelled: 'bg-slate-800 text-slate-400 border-slate-700',
  healthy: 'bg-emerald-950/40 text-emerald-300 border-emerald-800/50',
  degraded: 'bg-amber-950/40 text-amber-300 border-amber-800/50',
  dead: 'bg-rose-950/40 text-rose-300 border-rose-800/50',
  draining: 'bg-yellow-950/40 text-yellow-300 border-yellow-800/50',
  stopped: 'bg-slate-800 text-slate-400 border-slate-700',
  admin: 'bg-rose-950/40 text-rose-300 border-rose-800/50',
  developer: 'bg-blue-950/40 text-blue-300 border-blue-800/50',
  viewer: 'bg-slate-800 text-slate-400 border-slate-700',
  http_request: 'bg-slate-800 text-slate-300 border-slate-700',
  db_query: 'bg-slate-800 text-slate-300 border-slate-700',
  cpu_compute: 'bg-slate-800 text-slate-300 border-slate-700',
  notification_event: 'bg-slate-800 text-slate-300 border-slate-700'
};

export const Badge = ({ status, text, className = '' }) => {
  const style = statusStyles[status?.toLowerCase()] || 'bg-slate-800 text-slate-300 border-slate-700';
  const label = text || status;

  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded text-[11px] font-medium border ${style} ${className}`}
    >
      {label}
    </span>
  );
};
