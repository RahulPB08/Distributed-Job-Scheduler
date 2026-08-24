const API_BASE = '/api';

const request = async (url, options = {}) => {
  const token = localStorage.getItem('djs_token');
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers
  };

  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers
  });

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const error = new Error(data.error?.message || 'An error occurred');
    error.status = response.status;
    error.code = data.error?.code;
    throw error;
  }

  return data;
};

export const api = {
  auth: {
    login: (credentials) => request('/auth/login', { method: 'POST', body: JSON.stringify(credentials) }),
    register: (userData) => request('/auth/register', { method: 'POST', body: JSON.stringify(userData) }),
    me: () => request('/auth/me'),
    regenerateApiKey: () => request('/auth/api-key', { method: 'POST' }),
    listUsers: () => request('/auth/users'),
    getUserByEmail: (email) => request(`/auth/users/by-email?email=${encodeURIComponent(email)}`)
  },
  organizations: {
    list: () => request('/organizations'),
    create: (data) => request('/organizations', { method: 'POST', body: JSON.stringify(data) }),
    getById: (id) => request(`/organizations/${id}`),
    update: (id, data) => request(`/organizations/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/organizations/${id}`, { method: 'DELETE' }),
    getMembers: (orgId) => request(`/organizations/${orgId}/members`),
    addMember: (orgId, data) => request(`/organizations/${orgId}/members`, { method: 'POST', body: JSON.stringify(data) }),
    updateMemberRole: (orgId, userId, role) => request(`/organizations/${orgId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify({ role }) }),
    removeMember: (orgId, userId) => request(`/organizations/${orgId}/members/${userId}`, { method: 'DELETE' })
  },
  projects: {
    list: (orgId) => request(`/projects${orgId ? `?orgId=${orgId}` : ''}`),
    create: (data) => request('/projects', { method: 'POST', body: JSON.stringify(data) }),
    getById: (id) => request(`/projects/${id}`),
    update: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
    getStats: (id) => request(`/projects/${id}/stats`),
    listRetryPolicies: (id) => request(`/projects/${id}/retry-policies`),
    createRetryPolicy: (id, data) => request(`/projects/${id}/retry-policies`, { method: 'POST', body: JSON.stringify(data) })
  },
  queues: {
    list: (projectId) => request(`/queues${projectId ? `?projectId=${projectId}` : ''}`),
    create: (data) => request('/queues', { method: 'POST', body: JSON.stringify(data) }),
    getById: (id) => request(`/queues/${id}`),
    update: (id, data) => request(`/queues/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    pause: (id) => request(`/queues/${id}/pause`, { method: 'POST' }),
    resume: (id) => request(`/queues/${id}/resume`, { method: 'POST' }),
    purge: (id) => request(`/queues/${id}/purge`, { method: 'POST' }),
    scaleShards: (id, targetShards) => request(`/queues/${id}/shards/scale`, { method: 'POST', body: JSON.stringify({ targetShards }) }),
    delete: (id) => request(`/queues/${id}`, { method: 'DELETE' }),
    getStats: (id) => request(`/queues/${id}/stats`)
  },
  jobs: {
    list: (params = {}) => {
      const clean = Object.fromEntries(
        Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
      );
      const qs = new URLSearchParams(clean).toString();
      return request(`/jobs${qs ? `?${qs}` : ''}`);
    },
    create: (data) => request('/jobs', { method: 'POST', body: JSON.stringify(data) }),
    getById: (id) => request(`/jobs/${id}`),
    cancel: (id) => request(`/jobs/${id}/cancel`, { method: 'POST' }),
    retry: (id) => request(`/jobs/${id}/retry`, { method: 'POST' }),
    getLogs: (id) => request(`/jobs/${id}/logs`)
  },
  batches: {
    list: (projectId) => request(`/batches${projectId ? `?projectId=${projectId}` : ''}`),
    create: (data) => request('/batches', { method: 'POST', body: JSON.stringify(data) }),
    getById: (id) => request(`/batches/${id}`),
    cancel: (id) => request(`/batches/${id}/cancel`, { method: 'POST' })
  },
  schedules: {
    list: (projectId) => request(`/schedules${projectId ? `?projectId=${projectId}` : ''}`),
    create: (data) => request('/schedules', { method: 'POST', body: JSON.stringify(data) }),
    getById: (id) => request(`/schedules/${id}`),
    update: (id, data) => request(`/schedules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    toggle: (id) => request(`/schedules/${id}/toggle`, { method: 'POST' }),
    trigger: (id) => request(`/schedules/${id}/trigger`, { method: 'POST' }),
    delete: (id) => request(`/schedules/${id}`, { method: 'DELETE' })
  },
  workers: {
    list: () => request('/workers'),
    getAutoscale: () => request('/workers/autoscale'),
    updateAutoscale: (data) => request('/workers/autoscale', { method: 'PUT', body: JSON.stringify(data) }),
    scaleFleet: (targetWorkers) => request('/workers/scale', { method: 'POST', body: JSON.stringify({ targetWorkers }) }),
    provision: (data) => request('/workers/provision', { method: 'POST', body: JSON.stringify(data) }),
    drain: (id) => request(`/workers/${id}/drain`, { method: 'POST' }),
    stop: (id) => request(`/workers/${id}/stop`, { method: 'POST' }),
    getById: (id) => request(`/workers/${id}`),
    getExecutions: (id, orgId, isAdmin) => request(`/workers/${id}/executions?orgId=${orgId || ''}&isAdmin=${isAdmin ? 'true' : 'false'}`)
  },
  dlq: {
    list: (params = {}) => {
      const qs = new URLSearchParams(params).toString();
      return request(`/dlq${qs ? `?${qs}` : ''}`);
    },
    getById: (id) => request(`/dlq/${id}`),
    retry: (id) => request(`/dlq/${id}/retry`, { method: 'POST' }),
    bulkRetry: (dlqIds) => request('/dlq/bulk-retry', { method: 'POST', body: JSON.stringify({ dlqIds }) }),
    purge: (id) => request(`/dlq/${id}`, { method: 'DELETE' }),
    diagnose: (id) => request(`/dlq/${id}/diagnose`, { method: 'POST' })
  },
  metrics: {
    getOverview: (orgId) => request(`/metrics/overview${orgId ? `?orgId=${orgId}` : ''}`),
    getThroughput: (orgId) => request(`/metrics/throughput${orgId ? `?orgId=${orgId}` : ''}`),
    getLatency: (orgId) => request(`/metrics/latency${orgId ? `?orgId=${orgId}` : ''}`),
    getQueueDepths: (orgId) => request(`/metrics/queue-depths${orgId ? `?orgId=${orgId}` : ''}`),
    getEvents: (limit) => request(`/metrics/events${limit ? `?limit=${limit}` : ''}`),
    getLocks: () => request('/metrics/locks'),
    getAutoscaler: () => request('/metrics/autoscaler')
  },
  workflows: {
    listDAGs: (projectId) => request(`/workflows/dag${projectId ? `?projectId=${projectId}` : ''}`),
    createDAG: (data) => request('/workflows/dag', { method: 'POST', body: JSON.stringify(data) }),
    addDependency: (data) => request('/workflows/dependencies', { method: 'POST', body: JSON.stringify(data) }),
    removeDependency: (id) => request(`/workflows/dependencies/${id}`, { method: 'DELETE' })
  },
  events: {
    emit: (data) => request('/events/emit', { method: 'POST', body: JSON.stringify(data) }),
    listTriggers: (projectId) => request(`/events/triggers${projectId ? `?projectId=${projectId}` : ''}`),
    createTrigger: (data) => request('/events/triggers', { method: 'POST', body: JSON.stringify(data) }),
    toggleTrigger: (id) => request(`/events/triggers/${id}/toggle`, { method: 'PATCH' }),
    deleteTrigger: (id) => request(`/events/triggers/${id}`, { method: 'DELETE' })
  },
  retryPolicies: {
    listForProject: (projectId) => request(`/projects/${projectId}/retry-policies`),
    create: (projectId, data) => request(`/projects/${projectId}/retry-policies`, { method: 'POST', body: JSON.stringify(data) }),
    getById: (id) => request(`/retry-policies/${id}`),
    update: (id, data) => request(`/retry-policies/${id}`, { method: 'PATCH', body: JSON.stringify(data) }),
    delete: (id) => request(`/retry-policies/${id}`, { method: 'DELETE' })
  }
};
