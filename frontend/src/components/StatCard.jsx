import React from 'react';

export const StatCard = ({ title, value, subtitle, icon: Icon }) => {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-medium text-slate-400">{title}</p>
        {Icon && <Icon className="h-4 w-4 text-slate-500" />}
      </div>
      <p className="mt-2 text-2xl font-semibold text-slate-100">{value}</p>
      {subtitle && <p className="mt-1 text-xs text-slate-500">{subtitle}</p>}
    </div>
  );
};
