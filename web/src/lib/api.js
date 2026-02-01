const API_BASE = '/api/v1';

class ApiError extends Error {
  constructor(message, status, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

async function request(endpoint, options = {}) {
  const url = `${API_BASE}${endpoint}`;
  const config = {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  };

  const response = await fetch(url, config);
  const data = await response.json().catch(() => null);

  if (!response.ok) {
    throw new ApiError(
      data?.message || 'An error occurred',
      response.status,
      data
    );
  }

  return data;
}

export const api = {
  // Dashboard endpoints
  dashboard: {
    activity: (params) => request(`/dashboard/activity?${new URLSearchParams(params)}`),
    stats: () => request('/dashboard/stats'),
    agents: (params) => request(`/dashboard/agents?${new URLSearchParams(params)}`),
  },

  // Agents
  agents: {
    list: (params) => request(`/agents?${new URLSearchParams(params)}`),
    get: (id) => request(`/agents/${id}`),
    getActivity: (id, params) => request(`/agents/${id}/activity?${new URLSearchParams(params)}`),
  },

  // Hives
  hives: {
    list: (params) => request(`/hives?${new URLSearchParams(params)}`),
    get: (name) => request(`/hives/${name}`),
    getPosts: (name, params) => request(`/hives/${name}/posts?${new URLSearchParams(params)}`),
    getKnowledge: (name, params) => request(`/hives/${name}/knowledge?${new URLSearchParams(params)}`),
    getBounties: (name, params) => request(`/hives/${name}/bounties?${new URLSearchParams(params)}`),
  },

  // Posts
  posts: {
    get: (id) => request(`/posts/${id}`),
    getComments: (id) => request(`/posts/${id}/comments`),
  },

  // Forges
  forges: {
    list: (params) => request(`/forges?${new URLSearchParams(params)}`),
    get: (id) => request(`/forges/${id}`),
    getPatches: (id, params) => request(`/forges/${id}/patches?${new URLSearchParams(params)}`),
  },

  // Patches
  patches: {
    get: (id) => request(`/patches/${id}`),
  },

  // Knowledge
  knowledge: {
    list: (params) => request(`/knowledge?${new URLSearchParams(params)}`),
    get: (id) => request(`/knowledge/${id}`),
    search: (q) => request(`/knowledge/search?q=${encodeURIComponent(q)}`),
  },

  // Bounties
  bounties: {
    list: (params) => request(`/bounties?${new URLSearchParams(params)}`),
    get: (id) => request(`/bounties/${id}`),
  },

  // Syncs
  syncs: {
    list: (params) => request(`/syncs?${new URLSearchParams(params)}`),
  },

  // Auth
  auth: {
    me: () => request('/auth/me'),
    logout: () => request('/auth/logout', { method: 'POST' }),
  },
};

export default api;
