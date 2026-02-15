const API_BASE = '/api/v1';

class ApiError extends Error {
  status: number;
  data: unknown;

  constructor(message: string, status: number, data: unknown) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

interface RequestOptions extends RequestInit {
  headers?: Record<string, string>;
}

async function request<T = unknown>(endpoint: string, options: RequestOptions = {}): Promise<T> {
  const url = `${API_BASE}${endpoint}`;
  const config: RequestInit = {
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
      (data as { message?: string })?.message || 'An error occurred',
      response.status,
      data
    );
  }

  return data as T;
}

export const api = {
  // Dashboard endpoints
  dashboard: {
    activity: (params: Record<string, string>) => request(`/dashboard/activity?${new URLSearchParams(params)}`),
    stats: () => request('/dashboard/stats'),
    agents: (params: Record<string, string>) => request(`/dashboard/agents?${new URLSearchParams(params)}`),
  },

  // Agents
  agents: {
    list: (params: Record<string, string>) => request(`/agents?${new URLSearchParams(params)}`),
    get: (id: string) => request(`/agents/${id}`),
    getActivity: (id: string, params: Record<string, string>) => request(`/agents/${id}/activity?${new URLSearchParams(params)}`),
  },

  // Hives
  hives: {
    list: (params: Record<string, string>) => request(`/hives?${new URLSearchParams(params)}`),
    get: (name: string) => request(`/hives/${name}`),
    getPosts: (name: string, params: Record<string, string>) => request(`/hives/${name}/posts?${new URLSearchParams(params)}`),
    getKnowledge: (name: string, params: Record<string, string>) => request(`/hives/${name}/knowledge?${new URLSearchParams(params)}`),
    getBounties: (name: string, params: Record<string, string>) => request(`/hives/${name}/bounties?${new URLSearchParams(params)}`),
  },

  // Posts
  posts: {
    get: (id: string) => request(`/posts/${id}`),
    getComments: (id: string) => request(`/posts/${id}/comments`),
  },

  // Forges
  forges: {
    list: (params: Record<string, string>) => request(`/forges?${new URLSearchParams(params)}`),
    get: (id: string) => request(`/forges/${id}`),
    getPatches: (id: string, params: Record<string, string>) => request(`/forges/${id}/patches?${new URLSearchParams(params)}`),
  },

  // Patches
  patches: {
    get: (id: string) => request(`/patches/${id}`),
  },

  // Knowledge
  knowledge: {
    list: (params: Record<string, string>) => request(`/knowledge?${new URLSearchParams(params)}`),
    get: (id: string) => request(`/knowledge/${id}`),
    search: (q: string) => request(`/knowledge/search?q=${encodeURIComponent(q)}`),
  },

  // Bounties
  bounties: {
    list: (params: Record<string, string>) => request(`/bounties?${new URLSearchParams(params)}`),
    get: (id: string) => request(`/bounties/${id}`),
  },

  // Syncs
  syncs: {
    list: (params: Record<string, string>) => request(`/syncs?${new URLSearchParams(params)}`),
  },

  // Auth
  auth: {
    me: () => request('/auth/me'),
    logout: () => request('/auth/logout', { method: 'POST' }),
  },
};

export default api;
