import React, { useState } from 'react';
import { Layers, Lock, Mail, User, Shield, ArrowRight, Zap, Server, Activity } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

const PARTICLES = Array.from({ length: 20 }, (_, i) => ({
  id: i,
  x: Math.random() * 100,
  y: Math.random() * 100,
  size: Math.random() * 2 + 1,
  delay: Math.random() * 3,
  duration: Math.random() * 4 + 3,
}));

export const Login = () => {
  const { login, register } = useAuth();
  const [isRegister, setIsRegister] = useState(false);
  const [email, setEmail] = useState('admin@djs.io');
  const [password, setPassword] = useState('AdminPassword123!');
  const [name, setName] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      if (isRegister) {
        await register({ email, password, name });
      } else {
        await login(email, password);
      }
    } catch (err) {
      setError(err.message || 'Authentication failed. Please check your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const quickFill = (e, p) => {
    setEmail(e); setPassword(p); setIsRegister(false); setError(null);
  };

  return (
    <div className="min-h-screen flex overflow-hidden relative" style={{ background: 'var(--bg)' }}>
      {/* ── Animated Background ── */}
      <div className="absolute inset-0 bg-grid opacity-40 pointer-events-none" />
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        <div className="absolute top-1/4 left-1/3 w-96 h-96 rounded-full bg-indigo-600/8 blur-3xl animate-float" />
        <div className="absolute bottom-1/4 right-1/4 w-80 h-80 rounded-full bg-violet-600/6 blur-3xl animate-float" style={{ animationDelay: '1.5s' }} />
        <div className="absolute top-3/4 left-1/4 w-64 h-64 rounded-full bg-cyan-600/5 blur-3xl animate-float" style={{ animationDelay: '0.8s' }} />
        {/* Floating particles */}
        {PARTICLES.map(p => (
          <div
            key={p.id}
            className="absolute rounded-full bg-indigo-400/20 animate-float"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.size,
              height: p.size,
              animationDelay: `${p.delay}s`,
              animationDuration: `${p.duration}s`,
            }}
          />
        ))}
      </div>

      {/* ── Left Panel — Branding ── */}
      <div className="hidden lg:flex flex-col justify-between w-[52%] p-14 relative">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl grad-primary flex items-center justify-center shadow-lg">
            <Layers className="w-5 h-5 text-white" />
          </div>
          <span className="text-white font-bold text-lg tracking-tight">DJS Platform</span>
        </div>

        <div className="space-y-10">
          <div>
            <h1 className="text-5xl font-black text-white leading-[1.1] tracking-tight">
              Distributed Job<br />
              <span className="gradient-text">Scheduler</span>
            </h1>
            <p className="text-slate-400 text-lg mt-4 leading-relaxed max-w-md">
              Production-grade async job execution across distributed workers with real-time telemetry, auto-scaling, and intelligent retry logic.
            </p>
          </div>

          <div className="grid grid-cols-1 gap-4 max-w-md">
            {[
              { icon: Zap, color: 'text-amber-400', bg: 'bg-amber-500/10 border-amber-500/20', label: 'Atomic Job Claiming', desc: 'ACID-safe concurrent worker slot acquisition' },
              { icon: Server, color: 'text-indigo-400', bg: 'bg-indigo-500/10 border-indigo-500/20', label: 'Per-Project Auto-Scaling', desc: 'Dynamic worker fleet with configurable concurrency' },
              { icon: Activity, color: 'text-emerald-400', bg: 'bg-emerald-500/10 border-emerald-500/20', label: 'Live WebSocket Telemetry', desc: 'Real-time job state changes broadcast via DB polling' },
            ].map(({ icon: Icon, color, bg, label, desc }) => (
              <div key={label} className={`flex items-start gap-4 p-4 rounded-2xl border ${bg} backdrop-blur-sm`}>
                <div className={`p-2 rounded-lg ${bg}`}>
                  <Icon className={`w-5 h-5 ${color}`} />
                </div>
                <div>
                  <p className="text-white font-semibold text-sm">{label}</p>
                  <p className="text-slate-400 text-xs mt-0.5">{desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <p className="text-slate-600 text-xs">
          Built with Node.js · Express · SQLite (WAL) · Redis · React
        </p>
      </div>

      {/* ── Right Panel — Auth Form ── */}
      <div className="flex-1 flex items-center justify-center p-6">
        <div className="w-full max-w-md animate-fade-in-up">
          {/* Logo on mobile */}
          <div className="lg:hidden flex items-center gap-3 mb-8">
            <div className="w-9 h-9 rounded-xl grad-primary flex items-center justify-center">
              <Layers className="w-5 h-5 text-white" />
            </div>
            <span className="text-white font-bold text-lg">DJS Platform</span>
          </div>

          <div className="glass-card p-8">
            {/* Tab switcher */}
            <div className="flex gap-1 p-1 bg-slate-900/80 rounded-xl mb-8 border border-slate-800">
              {['Sign In', 'Register'].map((tab, i) => (
                <button
                  key={tab}
                  onClick={() => { setIsRegister(i === 1); setError(null); }}
                  className={`flex-1 py-2.5 text-sm font-semibold rounded-lg transition-all duration-200 ${
                    isRegister === (i === 1)
                      ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/30'
                      : 'text-slate-400 hover:text-slate-200'
                  }`}
                >
                  {tab}
                </button>
              ))}
            </div>

            <div className="mb-6">
              <h2 className="text-2xl font-bold text-white">{isRegister ? 'Create account' : 'Welcome back'}</h2>
              <p className="text-slate-400 text-sm mt-1">
                {isRegister ? 'Join the DJS platform' : 'Sign in to your workspace'}
              </p>
            </div>

            {error && (
              <div className="flex items-start gap-3 p-4 mb-6 rounded-xl bg-rose-500/8 border border-rose-500/20 text-rose-300 text-sm">
                <span className="text-rose-400 mt-0.5">⚠</span>
                <span>{error}</span>
              </div>
            )}

            <form onSubmit={handleSubmit} className="space-y-4">
              {isRegister && (
                <div>
                  <label className="block text-sm font-medium text-slate-300 mb-2">Full Name</label>
                  <div className="relative">
                    <User className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                    <input
                      type="text" required placeholder="Jane Doe"
                      value={name} onChange={e => setName(e.target.value)}
                      className="djs-input pl-10"
                    />
                  </div>
                </div>
              )}

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="email" required placeholder="you@company.com"
                    value={email} onChange={e => setEmail(e.target.value)}
                    className="djs-input pl-10"
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-slate-300 mb-2">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
                  <input
                    type="password" required placeholder="••••••••"
                    value={password} onChange={e => setPassword(e.target.value)}
                    className="djs-input pl-10"
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="btn-primary w-full justify-center mt-2 py-3 text-sm"
              >
                {loading ? (
                  <>
                    <div className="w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin-slow" />
                    <span>Authenticating...</span>
                  </>
                ) : (
                  <>
                    <span>{isRegister ? 'Create Account' : 'Sign In'}</span>
                    <ArrowRight className="w-4 h-4" />
                  </>
                )}
              </button>
            </form>

            {/* Quick access */}
            {!isRegister && (
              <div className="mt-6 pt-6 border-t border-slate-800/80">
                <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest mb-3">Demo Access</p>
                <div className="grid grid-cols-2 gap-3">
                  {[
                    { email: 'admin@djs.io', password: 'AdminPassword123!', label: 'System Admin', role: 'admin', icon: Shield, color: 'text-rose-400', bg: 'border-rose-500/15 hover:border-rose-500/30 hover:bg-rose-500/5' },
                    { email: 'dev@djs.io',   password: 'DevPassword123!',   label: 'Developer',    role: 'dev',   icon: User,   color: 'text-blue-400',  bg: 'border-blue-500/15 hover:border-blue-500/30 hover:bg-blue-500/5' },
                  ].map(acc => (
                    <button
                      key={acc.email}
                      type="button"
                      onClick={() => quickFill(acc.email, acc.password)}
                      className={`p-3 rounded-xl border text-left transition-all duration-200 ${acc.bg} bg-slate-900/50`}
                    >
                      <div className="flex items-center gap-2 mb-1">
                        <acc.icon className={`w-3.5 h-3.5 ${acc.color}`} />
                        <span className="text-xs font-semibold text-slate-200">{acc.label}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">{acc.email}</div>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
