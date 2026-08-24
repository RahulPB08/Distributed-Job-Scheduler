import React, { createContext, useContext, useState, useEffect } from 'react';
import { api } from '../api/endpoints.js';
import { useAuth } from './AuthContext.jsx';

const ProjectContext = createContext(null);

export const ProjectProvider = ({ children }) => {
  const { isAuthenticated, user } = useAuth();
  const [organizations, setOrganizations] = useState([]);
  const [currentOrg, setCurrentOrg] = useState(null);
  const [projects, setProjects] = useState([]);
  const [currentProject, setCurrentProject] = useState(null);
  const [loading, setLoading] = useState(true);

  const fetchOrganizations = async () => {
    if (!isAuthenticated) return;
    try {
      const res = await api.organizations.list();
      const orgList = res.data || [];
      setOrganizations(orgList);

      const savedOrgId = localStorage.getItem('djs_selected_org_id');
      let selected = orgList.find((o) => o.id === savedOrgId) || orgList[0] || null;

      setCurrentOrg(selected);
      if (selected) {
        localStorage.setItem('djs_selected_org_id', selected.id);
        await fetchProjects(selected.id);
      } else {
        setProjects([]);
        setCurrentProject(null);
      }
    } catch (err) {
    } finally {
      setLoading(false);
    }
  };

  const fetchProjects = async (orgId) => {
    try {
      const res = await api.projects.list(orgId);
      const projList = res.data || [];
      setProjects(projList);

      const savedProjId = localStorage.getItem('djs_selected_project_id');
      const selectedProj = projList.find((p) => p.id === savedProjId) || projList[0] || null;

      setCurrentProject(selectedProj);
      if (selectedProj) {
        localStorage.setItem('djs_selected_project_id', selectedProj.id);
      }
    } catch (err) {}
  };

  useEffect(() => {
    if (isAuthenticated) {
      fetchOrganizations();
    } else {
      setOrganizations([]);
      setCurrentOrg(null);
      setProjects([]);
      setCurrentProject(null);
      setLoading(false);
    }
  }, [isAuthenticated]);

  const selectOrg = async (org) => {
    setCurrentOrg(org);
    if (org) {
      localStorage.setItem('djs_selected_org_id', org.id);
      await fetchProjects(org.id);
    }
  };

  const selectProject = (project) => {
    setCurrentProject(project);
    if (project) {
      localStorage.setItem('djs_selected_project_id', project.id);
    }
  };

  const createOrg = async (data) => {
    const res = await api.organizations.create(data);
    await fetchOrganizations();
    if (res.data) {
      await selectOrg(res.data);
    }
    return res.data;
  };

  const createProject = async (data) => {
    const payload = {
      ...data,
      orgId: currentOrg?.id
    };
    const res = await api.projects.create(payload);
    if (currentOrg) {
      await fetchProjects(currentOrg.id);
    }
    if (res.data) {
      setCurrentProject(res.data);
    }
    return res.data;
  };

  return (
    <ProjectContext.Provider
      value={{
        organizations,
        currentOrg,
        selectOrg,
        createOrg,
        projects,
        currentProject,
        selectProject,
        createProject,
        refreshProjects: () => currentOrg && fetchProjects(currentOrg.id),
        refreshOrgs: fetchOrganizations,
        loading
      }}
    >
      {children}
    </ProjectContext.Provider>
  );
};

export const useProject = () => useContext(ProjectContext);
