import React, { useState, useEffect, useCallback } from 'react';
import { AuthProvider, useAuth } from './context/AuthContext.jsx';
import { ProjectProvider } from './context/ProjectContext.jsx';
import { WebSocketProvider } from './context/WebSocketContext.jsx';
import { Login } from './pages/Login.jsx';
import { Navbar } from './components/Navbar.jsx';
import { Sidebar } from './components/Sidebar.jsx';
import { Dashboard } from './pages/Dashboard.jsx';
import { QueueManager } from './pages/QueueManager.jsx';
import { JobExplorer } from './pages/JobExplorer.jsx';
import { BatchManager } from './pages/BatchManager.jsx';
import { ScheduleManager } from './pages/ScheduleManager.jsx';
import { EventManager } from './pages/EventManager.jsx';
import { WorkerFleet } from './pages/WorkerFleet.jsx';
import { DeadLetterQueue } from './pages/DeadLetterQueue.jsx';
import { WorkflowDAG } from './pages/WorkflowDAG.jsx';
import { MetricsAnalytics } from './pages/MetricsAnalytics.jsx';
import { Projects } from './pages/Projects.jsx';
import { MemberManagement } from './pages/MemberManagement.jsx';

const VALID_TABS = [
  'overview',
  'queues',
  'jobs',
  'batches',
  'schedules',
  'events',
  'workers',
  'dlq',
  'dag',
  'metrics',
  'projects',
  'members'
];

const getTabFromLocation = () => {
  const path = window.location.pathname.replace(/^\/+/, '').split('/')[0] || '';
  if (path === '' || path === 'overview') return 'overview';
  if (VALID_TABS.includes(path)) return path;
  return 'overview';
};

const getJobIdFromLocation = () => {
  const params = new URLSearchParams(window.location.search);
  return params.get('jobId') || null;
};

const AuthenticatedApp = () => {
  const { user, isAuthenticated, loading } = useAuth();
  const [activeTab, setActiveTab] = useState(getTabFromLocation);
  const [selectedJobId, setSelectedJobId] = useState(getJobIdFromLocation);

  // Sync state when browser Back / Forward buttons are pressed
  useEffect(() => {
    const handlePopState = () => {
      setActiveTab(getTabFromLocation());
      setSelectedJobId(getJobIdFromLocation());
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  if (loading) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center" style={{ background: 'var(--color-bg)' }}>
        <div className="relative">
          <div className="w-16 h-16 rounded-2xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center mb-4 animate-float">
            <span className="text-white font-black text-2xl">D</span>
          </div>
        </div>
        <p className="text-indigo-400 font-mono text-xs mt-4 animate-blink">Initializing Distributed Job Scheduler...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  const handleTabChange = (tab) => {
    setSelectedJobId(null);
    setActiveTab(tab);
    const targetPath = tab === 'overview' ? '/' : `/${tab}`;
    if (window.location.pathname !== targetPath) {
      window.history.pushState({}, '', targetPath);
    }
  };

  const handleViewJob = (jobId) => {
    setSelectedJobId(jobId);
    setActiveTab('jobs');
    window.history.pushState({}, '', `/jobs?jobId=${encodeURIComponent(jobId)}`);
  };

  const isAdmin = user?.role === 'admin';

  return (
    <ProjectProvider>
      <WebSocketProvider>
        <div className="min-h-screen flex flex-col" style={{ background: 'var(--color-bg)' }}>
          <Navbar />
          <div className="flex flex-1 overflow-hidden">
            <Sidebar activeTab={activeTab} setActiveTab={handleTabChange} />
            <main className="flex-1 overflow-y-auto p-6">
              {activeTab === 'overview'  && <Dashboard onViewJob={handleViewJob} />}
              {activeTab === 'queues'    && <QueueManager />}
              {activeTab === 'jobs'      && (
                <JobExplorer
                  initialSelectedJobId={selectedJobId}
                  onClearSelectedJob={() => {
                    setSelectedJobId(null);
                    window.history.replaceState({}, '', '/jobs');
                  }}
                />
              )}
              {activeTab === 'batches'   && <BatchManager onViewJob={handleViewJob} />}
              {activeTab === 'schedules' && <ScheduleManager />}
              {activeTab === 'events'    && <EventManager onViewJob={handleViewJob} />}
              {activeTab === 'workers'   && <WorkerFleet />}
              {activeTab === 'dlq'       && <DeadLetterQueue onViewJob={handleViewJob} />}
              {activeTab === 'dag'       && <WorkflowDAG onViewJob={handleViewJob} />}
              {activeTab === 'metrics'   && <MetricsAnalytics />}
              {activeTab === 'projects'  && <Projects />}
              {activeTab === 'members'   && <MemberManagement />}
            </main>
          </div>
        </div>
      </WebSocketProvider>
    </ProjectProvider>
  );
};

export default function App() {
  return (
    <AuthProvider>
      <AuthenticatedApp />
    </AuthProvider>
  );
}
