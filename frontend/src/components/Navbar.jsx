import React, { useState, useEffect } from 'react';
import {
  Layers,
  ChevronDown,
  Check,
  Key,
  LogOut,
  Building2,
  Plus,
  Users,
  Trash2,
  FolderPlus
} from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';
import { useProject } from '../context/ProjectContext.jsx';
import { useWebSocket } from '../context/WebSocketContext.jsx';
import { Badge } from './Badge.jsx';
import { Modal } from './Modal.jsx';
import { api } from '../api/endpoints.js';

export const Navbar = () => {
  const { user, logout } = useAuth();
  const {
    organizations,
    currentOrg,
    selectOrg,
    createOrg,
    projects,
    currentProject,
    selectProject,
    createProject
  } = useProject();
  const { isConnected } = useWebSocket();

  const [showOrgDropdown, setShowOrgDropdown] = useState(false);
  const [showProjDropdown, setShowProjDropdown] = useState(false);
  const [showApiKeyModal, setShowApiKeyModal] = useState(false);
  const [showCreateOrgModal, setShowCreateOrgModal] = useState(false);
  const [showCreateProjModal, setShowCreateProjModal] = useState(false);
  const [showMembersModal, setShowMembersModal] = useState(false);

  const [orgName, setOrgName] = useState('');
  const [projName, setProjName] = useState('');
  const [projDesc, setProjDesc] = useState('');
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState('member');
  const [membersList, setMembersList] = useState([]);
  const [membersLoading, setMembersLoading] = useState(false);
  const [memberMessage, setMemberMessage] = useState(null);
  const [memberError, setMemberError] = useState(null);

  const [apiKey, setApiKey] = useState(user?.apiKey || '');
  const [copied, setCopied] = useState(false);

  const isOrgLeader = currentOrg && (currentOrg.creator_id === user?.id || user?.role === 'admin');

  const fetchMembers = async () => {
    if (!currentOrg) return;
    setMembersLoading(true);
    setMemberError(null);
    try {
      const res = await api.organizations.getMembers(currentOrg.id);
      setMembersList(res.data || []);
    } catch (err) {
      setMemberError(err.message);
    } finally {
      setMembersLoading(false);
    }
  };

  useEffect(() => {
    if (showMembersModal && currentOrg) {
      fetchMembers();
    }
  }, [showMembersModal, currentOrg]);

  const handleCopyApiKey = () => {
    navigator.clipboard.writeText(apiKey);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleRegenerateApiKey = async () => {
    try {
      const res = await api.auth.regenerateApiKey();
      setApiKey(res.data.apiKey);
    } catch (err) { }
  };

  const handleCreateOrgSubmit = async (e) => {
    e.preventDefault();
    try {
      await createOrg({ name: orgName });
      setOrgName('');
      setShowCreateOrgModal(false);
    } catch (err) { }
  };

  const handleCreateProjSubmit = async (e) => {
    e.preventDefault();
    try {
      await createProject({ name: projName, description: projDesc });
      setProjName('');
      setProjDesc('');
      setShowCreateProjModal(false);
    } catch (err) { }
  };

  const handleAddMemberSubmit = async (e) => {
    e.preventDefault();
    setMemberError(null);
    setMemberMessage(null);
    try {
      const res = await api.organizations.addMember(currentOrg.id, {
        email: inviteEmail,
        role: inviteRole
      });
      setMemberMessage(res.message || 'Member added successfully');
      setInviteEmail('');
      fetchMembers();
    } catch (err) {
      setMemberError(err.message || 'Failed to add member');
    }
  };

  const handleRemoveMember = async (userId) => {
    if (window.confirm('Remove this member from the organization?')) {
      try {
        await api.organizations.removeMember(currentOrg.id, userId);
        fetchMembers();
      } catch (err) {
        setMemberError(err.message);
      }
    }
  };

  return (
    <>
      <header className="sticky top-0 z-30 flex h-14 w-full items-center justify-between border-b border-slate-800 bg-slate-900 px-5">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <div className="flex h-7 w-7 items-center justify-center rounded bg-slate-800 text-blue-400 font-bold border border-slate-700">
              <Layers className="h-4 w-4" />
            </div>
            <span className="text-sm font-semibold text-slate-100 hidden sm:inline">Job Scheduler</span>
          </div>

          <div className="relative">
            <button
              onClick={() => {
                setShowOrgDropdown(!showOrgDropdown);
                setShowProjDropdown(false);
              }}
              className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
            >
              <Building2 className="h-3.5 w-3.5 text-slate-400" />
              <span className="font-medium truncate max-w-[130px]">{currentOrg?.name || 'Organization'}</span>
              <ChevronDown className="h-3 w-3 text-slate-400" />
            </button>

            {showOrgDropdown && (
              <div className="absolute left-0 mt-1 w-56 rounded border border-slate-700 bg-slate-900 py-1 shadow-lg z-50">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase text-slate-500">
                  Organizations
                </div>
                {organizations.map((org) => (
                  <button
                    key={org.id}
                    onClick={() => {
                      selectOrg(org);
                      setShowOrgDropdown(false);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${currentOrg?.id === org.id
                        ? 'bg-slate-800 text-blue-400 font-medium'
                        : 'text-slate-300 hover:bg-slate-800/60'
                      }`}
                  >
                    <span className="truncate">{org.name}</span>
                    {currentOrg?.id === org.id && <Check className="h-3 w-3 text-blue-400 shrink-0" />}
                  </button>
                ))}
                <div className="border-t border-slate-800 mt-1 pt-1">
                  <button
                    onClick={() => {
                      setShowOrgDropdown(false);
                      setShowCreateOrgModal(true);
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-blue-400 hover:bg-slate-800/60"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>New Organization</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="relative">
            <button
              onClick={() => {
                setShowProjDropdown(!showProjDropdown);
                setShowOrgDropdown(false);
              }}
              className="flex items-center gap-1.5 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-200 hover:bg-slate-700"
            >
              <span className="text-slate-400">Project:</span>
              <span className="font-medium truncate max-w-[130px]">{currentProject?.name || 'Select Project'}</span>
              <ChevronDown className="h-3 w-3 text-slate-400" />
            </button>

            {showProjDropdown && (
              <div className="absolute left-0 mt-1 w-56 rounded border border-slate-700 bg-slate-900 py-1 shadow-lg z-50">
                <div className="px-3 py-1 text-[10px] font-semibold uppercase text-slate-500">
                  Projects ({currentOrg?.name || ''})
                </div>
                {projects.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => {
                      selectProject(p);
                      setShowProjDropdown(false);
                    }}
                    className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs ${currentProject?.id === p.id
                        ? 'bg-slate-800 text-blue-400 font-medium'
                        : 'text-slate-300 hover:bg-slate-800/60'
                      }`}
                  >
                    <span className="truncate">{p.name}</span>
                    {currentProject?.id === p.id && <Check className="h-3 w-3 text-blue-400 shrink-0" />}
                  </button>
                ))}
                <div className="border-t border-slate-800 mt-1 pt-1">
                  <button
                    onClick={() => {
                      setShowProjDropdown(false);
                      setShowCreateProjModal(true);
                    }}
                    className="flex w-full items-center gap-1.5 px-3 py-1.5 text-left text-xs text-blue-400 hover:bg-slate-800/60"
                  >
                    <FolderPlus className="h-3.5 w-3.5" />
                    <span>New Project</span>
                  </button>
                </div>
              </div>
            )}
          </div>

          {isOrgLeader && (
            <button
              onClick={() => setShowMembersModal(true)}
              className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
            >
              <Users className="h-3 w-3 text-slate-400" />
              <span>Members</span>
            </button>
          )}
        </div>

        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className={`h-2 w-2 rounded-full ${isConnected ? 'bg-emerald-500' : 'bg-slate-500'}`} />
            <span className="text-[11px] font-mono hidden md:inline">{isConnected ? 'Live' : 'Offline'}</span>
          </div>

          <button
            onClick={() => {
              setApiKey(user?.apiKey || '');
              setShowApiKeyModal(true);
            }}
            className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800 px-2.5 py-1 text-xs text-slate-300 hover:bg-slate-700"
          >
            <Key className="h-3 w-3 text-slate-400" />
            <span className="hidden sm:inline">API Key</span>
          </button>

          <div className="flex items-center gap-2.5 border-l border-slate-800 pl-3">
            <div className="text-right">
              <span className="text-xs font-medium text-slate-200 block truncate max-w-[120px]">{user?.name}</span>
              <Badge status={user?.role} className="text-[10px] px-1.5 py-0 capitalize" />
            </div>
            <button
              onClick={logout}
              title="Sign Out"
              className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-slate-200"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      </header>

      <Modal isOpen={showCreateOrgModal} onClose={() => setShowCreateOrgModal(false)} title="Create Organization">
        <form onSubmit={handleCreateOrgSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-slate-300 mb-1">Organization Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Data Science Team"
              value={orgName}
              onChange={(e) => setOrgName(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-200 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setShowCreateOrgModal(false)}
              className="rounded border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-1.5 font-medium text-white hover:bg-blue-500"
            >
              Create
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={showCreateProjModal} onClose={() => setShowCreateProjModal(false)} title="Create Project">
        <form onSubmit={handleCreateProjSubmit} className="space-y-3 text-xs">
          <div>
            <label className="block font-medium text-slate-300 mb-1">Project Name</label>
            <input
              type="text"
              required
              placeholder="e.g. Ingestion Pipeline"
              value={projName}
              onChange={(e) => setProjName(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-200 focus:outline-none"
            />
          </div>
          <div>
            <label className="block font-medium text-slate-300 mb-1">Description</label>
            <textarea
              rows="2"
              placeholder="Optional project summary"
              value={projDesc}
              onChange={(e) => setProjDesc(e.target.value)}
              className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-slate-200 focus:outline-none"
            />
          </div>
          <div className="flex justify-end gap-2 pt-2 border-t border-slate-800">
            <button
              type="button"
              onClick={() => setShowCreateProjModal(false)}
              className="rounded border border-slate-700 px-3 py-1.5 text-slate-300 hover:bg-slate-800"
            >
              Cancel
            </button>
            <button
              type="submit"
              className="rounded bg-blue-600 px-4 py-1.5 font-medium text-white hover:bg-blue-500"
            >
              Create Project
            </button>
          </div>
        </form>
      </Modal>

      <Modal isOpen={showMembersModal} onClose={() => setShowMembersModal(false)} title={`Manage Members: ${currentOrg?.name}`} maxWidth="max-w-2xl">
        <div className="space-y-4 text-xs">
          {memberMessage && (
            <div className="rounded border border-emerald-800 bg-emerald-950/40 p-2 text-emerald-300">
              {memberMessage}
            </div>
          )}
          {memberError && (
            <div className="rounded border border-rose-800 bg-rose-950/40 p-2 text-rose-300">
              {memberError}
            </div>
          )}

          {isOrgLeader && (
            <form onSubmit={handleAddMemberSubmit} className="space-y-2.5 rounded border border-slate-800 bg-slate-950 p-3">
              <span className="font-semibold text-slate-200 block">Add Member by Email</span>
              <div className="flex gap-2">
                <input
                  type="email"
                  required
                  placeholder="developer@company.com"
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  className="flex-1 rounded border border-slate-700 bg-slate-900 px-2.5 py-1.5 text-slate-200 focus:outline-none"
                />
                <select
                  value={inviteRole}
                  onChange={(e) => setInviteRole(e.target.value)}
                  className="rounded border border-slate-700 bg-slate-900 px-2 py-1.5 text-slate-200 focus:outline-none"
                >
                  <option value="member">Member</option>
                  <option value="leader">Leader</option>
                </select>
                <button
                  type="submit"
                  className="rounded bg-blue-600 px-3.5 py-1.5 font-medium text-white hover:bg-blue-500 shrink-0"
                >
                  Add Member
                </button>
              </div>
            </form>
          )}

          <div>
            <span className="font-semibold text-slate-300 block mb-1.5">Current Members ({membersList.length})</span>
            <div className="max-h-52 overflow-y-auto rounded border border-slate-800 bg-slate-950">
              <table className="w-full text-left">
                <thead className="border-b border-slate-800 text-[11px] uppercase text-slate-500">
                  <tr>
                    <th className="p-2">Name</th>
                    <th className="p-2">Email</th>
                    <th className="p-2">Org Role</th>
                    {isOrgLeader && <th className="p-2 text-right">Action</th>}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/60 text-slate-300">
                  {membersList.map((m) => (
                    <tr key={m.id}>
                      <td className="p-2 font-medium text-slate-200">{m.name}</td>
                      <td className="p-2 font-mono text-slate-400">{m.email}</td>
                      <td className="p-2">
                        <Badge status={m.org_role === 'leader' ? 'completed' : 'scheduled'} text={m.org_role} />
                      </td>
                      {isOrgLeader && (
                        <td className="p-2 text-right">
                          {m.org_role !== 'leader' && (
                            <button
                              onClick={() => handleRemoveMember(m.id)}
                              className="text-slate-500 hover:text-rose-400"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </Modal>

      <Modal isOpen={showApiKeyModal} onClose={() => setShowApiKeyModal(false)} title="API Authentication Key">
        <div className="space-y-3 text-xs">
          <p className="text-slate-400">
            Pass this key in the <code className="text-slate-200 bg-slate-800 px-1 py-0.5 rounded font-mono">x-api-key</code> header for programmatic API access.
          </p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              readOnly
              value={apiKey}
              className="w-full rounded border border-slate-700 bg-slate-950 px-2.5 py-1.5 font-mono text-slate-200 focus:outline-none"
            />
            <button
              onClick={handleCopyApiKey}
              className="rounded bg-blue-600 px-3 py-1.5 font-medium text-white hover:bg-blue-500 shrink-0"
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div className="pt-2 flex justify-between items-center border-t border-slate-800">
            <button
              onClick={handleRegenerateApiKey}
              className="text-rose-400 hover:underline"
            >
              Regenerate Key
            </button>
            <button
              onClick={() => setShowApiKeyModal(false)}
              className="rounded border border-slate-700 px-3 py-1 text-slate-300 hover:bg-slate-800"
            >
              Close
            </button>
          </div>
        </div>
      </Modal>
    </>
  );
};
