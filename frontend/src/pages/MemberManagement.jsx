import React, { useState, useEffect, useCallback } from 'react';
import { api } from '../api/endpoints.js';
import { useAuth } from '../context/AuthContext.jsx';
import { useProject } from '../context/ProjectContext.jsx';
import {
  Users, UserPlus, Shield, ShieldOff, Trash2, Mail,
  Crown, Code2, RefreshCw, AlertCircle, CheckCircle, ChevronDown, UserCheck
} from 'lucide-react';

const ROLES = [
  { value: 'admin',     label: 'Admin',     icon: Shield, desc: 'Full org management, can invite/remove members' },
  { value: 'developer', label: 'Developer', icon: Code2,  desc: 'Can manage jobs, schedules, batches, and monitor workers' },
];

export const MemberManagement = () => {
  const { user } = useAuth();
  const { currentOrg: selectedOrg, organizations } = useProject();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  // Invite form
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('developer');
  const [inviting, setInviting] = useState(false);

  const effectiveOrg = selectedOrg || (organizations && organizations.length > 0 ? organizations[0] : null);
  const orgId = effectiveOrg?.id;

  const showToast = (msg, type = 'success') => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3500);
  };

  const fetchMembers = useCallback(async () => {
    if (!orgId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.organizations.getMembers(orgId);
      setMembers(res.data || []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [orgId]);

  useEffect(() => { fetchMembers(); }, [fetchMembers]);

  const handleInvite = async (e) => {
    e.preventDefault();
    if (!inviteEmail.trim()) return;
    setInviting(true);
    try {
      await api.organizations.addMember(orgId, { email: inviteEmail.trim(), role: inviteRole });
      showToast(`Added ${inviteEmail} as ${inviteRole}`);
      setInviteEmail('');
      fetchMembers();
    } catch (e) {
      showToast(e.message, 'error');
    } finally {
      setInviting(false);
    }
  };

  const handleChangeRole = async (userId, newRole) => {
    try {
      await api.organizations.updateMemberRole(orgId, userId, newRole);
      showToast('Role updated successfully');
      fetchMembers();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

  const handleRemove = async (userId, name) => {
    if (!window.confirm(`Remove ${name || 'this member'} from this organization?`)) return;
    try {
      await api.organizations.removeMember(orgId, userId);
      showToast(`${name || 'Member'} removed from organization`);
      fetchMembers();
    } catch (e) {
      showToast(e.message, 'error');
    }
  };

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
          <div className="p-2.5 rounded-xl bg-violet-500/10 border border-violet-500/20 text-violet-400">
            <Users className="w-5 h-5" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Organization Access &amp; RBAC</h1>
            <p className="text-xs text-slate-400 mt-0.5">
              Manage member roles, permissions, and collaborative project workspaces for {selectedOrg?.name || 'Organization'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={fetchMembers}
            className="btn-ghost text-xs gap-1.5"
            title="Refresh Member List"
          >
            <RefreshCw className="w-3.5 h-3.5" />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Invite Member Card */}
      <div className="glass-card p-5 space-y-3">
        <h3 className="text-sm font-bold text-white flex items-center gap-2">
          <UserPlus className="w-4 h-4 text-indigo-400" />
          <span>Invite Organization Member</span>
        </h3>
        <form onSubmit={handleInvite} className="flex flex-col sm:flex-row gap-3">
          <div className="relative flex-1">
            <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              type="email"
              required
              placeholder="colleague@company.com"
              value={inviteEmail}
              onChange={(e) => setInviteEmail(e.target.value)}
              className="djs-input pl-10 text-xs py-2"
            />
          </div>
          <select
            value={inviteRole}
            onChange={(e) => setInviteRole(e.target.value)}
            className="djs-select text-xs py-2 w-44"
          >
            <option value="developer">Developer</option>
            <option value="admin">Admin</option>
          </select>
          <button
            type="submit"
            disabled={inviting}
            className="btn-primary text-xs shrink-0 py-2 px-4"
          >
            <UserPlus className="w-4 h-4" />
            <span>{inviting ? 'Adding...' : 'Add Member'}</span>
          </button>
        </form>
      </div>

      {/* Members List */}
      <div className="glass-card overflow-hidden">
        <div className="p-4 border-b border-slate-800 flex items-center justify-between">
          <span className="font-bold text-white text-sm">Organization Members ({members.length})</span>
          <span className="text-xs text-slate-500 font-mono">Role-Based Access Control</span>
        </div>

        <div className="overflow-x-auto">
          <table className="djs-table">
            <thead>
              <tr>
                <th>Member</th>
                <th>Email Address</th>
                <th>Role</th>
                <th>Joined Date</th>
                <th className="text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="5" className="py-12 text-center text-slate-500">
                    <div className="flex items-center justify-center gap-2">
                      <RefreshCw className="w-4 h-4 animate-spin text-indigo-400" />
                      <span>Loading organization members...</span>
                    </div>
                  </td>
                </tr>
              ) : members.length === 0 ? (
                <tr>
                  <td colSpan="5" className="py-12 text-center text-slate-500">
                    No members found in this organization.
                  </td>
                </tr>
              ) : (
                members.map((m) => {
                  const memberId = m.id || m.user_id;
                  const memberRole = m.org_role || m.role || 'developer';
                  const isSelf = memberId === user?.id || m.email === user?.email;

                  return (
                    <tr key={memberId} className="transition-all hover:bg-slate-800/40">
                      <td>
                        <div className="flex items-center gap-2.5">
                          <div className="w-8 h-8 rounded-xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center font-bold text-indigo-400 text-xs">
                            {(m.name || m.email || '?')[0].toUpperCase()}
                          </div>
                          <div>
                            <p className="font-semibold text-slate-100">{m.name || 'Member'}</p>
                            <p className="text-[10px] font-mono text-slate-500">{memberId}</p>
                          </div>
                        </div>
                      </td>
                      <td className="font-mono text-xs text-slate-300">{m.email}</td>
                      <td>
                        <select
                          value={memberRole}
                          disabled={isSelf}
                          onChange={(e) => handleChangeRole(memberId, e.target.value)}
                          className="djs-select text-xs py-1 px-2 w-32 disabled:opacity-60"
                        >
                          <option value="developer">Developer</option>
                          <option value="admin">Admin</option>
                          <option value="leader">Leader</option>
                          <option value="member">Member</option>
                        </select>
                      </td>
                      <td className="font-mono text-xs text-slate-400">
                        {m.joined_at || m.created_at ? new Date(m.joined_at || m.created_at).toLocaleDateString() : 'N/A'}
                      </td>
                      <td className="text-right">
                        {!isSelf && (
                          <button
                            onClick={() => handleRemove(memberId, m.name || m.email)}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                            title="Remove Member"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
