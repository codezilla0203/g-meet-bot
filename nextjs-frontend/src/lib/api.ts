import axios from 'axios';
import Cookies from 'js-cookie';

// Get API base URL - use relative URLs for Next.js rewrites, or absolute for direct API calls
const getApiBaseUrl = () => {
  // Check if we should use relative URLs (when Next.js rewrites are configured)
  // or absolute URLs (when backend is on different domain/port)
  
  if (typeof window !== 'undefined') {
    // If NEXT_PUBLIC_API_URL is explicitly set, use it (for different domain/port)
    if (process.env.NEXT_PUBLIC_API_URL) {
      return process.env.NEXT_PUBLIC_API_URL;
    }
    
    // Use relative URLs - Next.js rewrites will proxy to backend
    // This works for both development and production
    return '';
  }
  
  // Server-side: use environment variable or default
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:5000';
};

const API_BASE_URL = getApiBaseUrl();
// Use relative URL for /api routes (Next.js will proxy)
// Use absolute URL only if API_BASE_URL is set
const API_URL = API_BASE_URL ? `${API_BASE_URL}/api` : '/api';

// Export for use in other files
export { getApiBaseUrl };

export const apiClient = axios.create({
  baseURL: API_URL,
  timeout: 10000,
  withCredentials: true,
});

// Add auth token to requests
apiClient.interceptors.request.use((config) => {
  const token = Cookies.get('auth_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Handle auth errors
apiClient.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      // If the failing request was an authentication endpoint (login/signup/forgot),
      // do NOT auto-redirect — allow the caller to handle the error and show messages.
      const reqUrl = error.config?.url || '';
      const path = String(reqUrl).toLowerCase();
      const authEndpoints = ['/login', '/signup', '/forgot-password', '/reset-password'];
      const isAuthEndpoint = authEndpoints.some(ep => path.endsWith(ep) || path.includes(ep));

      // Clear stored auth tokens regardless
      Cookies.remove('auth_token');
      Cookies.remove('user_email');

      if (!isAuthEndpoint) {
        // For protected API calls, redirect to signin
        try { window.location.href = '/signin'; } catch (e) {}
      }
      // For auth endpoints, don't redirect — let the page handle the 401 and show a message
    }
    return Promise.reject(error);
  }
);

// Bot API functions
export const botApi = {
  // Create a new bot
  createBot: async (data: {
    meeting_url: string;
    caption_language: string;
    recording_type: string;
    meeting_type: string;
    notification_emails?: string;
  }) => {
    const apiBase = getApiBaseUrl();
    const url = apiBase ? `${apiBase}/v1/bots` : '/v1/bots';
    const response = await axios.post(url, data, {
      headers: {
        Authorization: `Bearer ${Cookies.get('auth_token')}`,
      },
    });
    return response.data;
  },

  // Get all bots for the user
  getBots: async () => {
    const response = await apiClient.get('/bots');
    return response.data;
  },

  // Get bot details
  getBotDetails: async (botId: string) => {
    const response = await apiClient.get(`/bots/${botId}`);
    return response.data;
  },

  // Stop a bot
  stopBot: async (botId: string) => {
    const apiBase = getApiBaseUrl();
    const url = apiBase ? `${apiBase}/v1/bots/${botId}` : `/v1/bots/${botId}`;
    const response = await axios.delete(url, {
      headers: {
        Authorization: `Bearer ${Cookies.get('auth_token')}`,
      },
    });
    return response.data;
  },

  // Delete a bot
  deleteBot: async (botId: string) => {
    const apiBase = getApiBaseUrl();
    const url = apiBase ? `${apiBase}/v1/bots/${botId}` : `/v1/bots/${botId}`;
    const response = await axios.delete(url, {
      headers: {
        Authorization: `Bearer ${Cookies.get('auth_token')}`,
      },
    });
    return response.data;
  },
};

// Configuration API functions
export const configApi = {
  // Get user configuration
  getConfig: async () => {
    const response = await apiClient.get('/config');
    return response.data;
  },

  // Save user configuration
  saveConfig: async (config: {
    botName: string;
    webhookUrl: string;
    summaryTemplate: string;
    botLogoUrl: string;
    maxRecordingTime: number;
    totalRecordingMinutes: number;
  }) => {
    const response = await apiClient.post('/configSave', config);
    return response.data;
  },
};

export default apiClient;
