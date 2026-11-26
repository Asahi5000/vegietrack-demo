import axios from 'axios';

// On localhost → hit the local Node.js backend on port 5000
// On Vercel (or any other host) → use relative /api which maps to the serverless function
const defaultBaseUrl =
  typeof window !== 'undefined' &&
  (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1')
    ? 'http://localhost:5000/api'
    : '/api';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || defaultBaseUrl,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('vegietrack_token');
  if (token) {
    config.headers['Authorization'] = `Bearer ${token}`;
    config.headers['X-Auth-Token'] = token;
  }
  return config;
});

/**
 * Determine whether a failed response is an authentication error
 * (expired/invalid token) rather than a genuine permissions error (403
 * "Insufficient permissions").
 *
 * HTTP 401 always means "not authenticated". A 403 is only treated as an
 * auth error when the message mentions a token, expiry or authentication —
 * that lets the interceptor log the user out and redirect to /login while
 * leaving legitimate permission-denied responses untouched.
 */
function isAuthError(error) {
  if (!error.response) return false;
  const status = error.response.status;
  const message = error.response.data?.message || '';
  if (status === 401) return true;
  if (status === 403) {
    return /token|expired|auth/i.test(message);
  }
  return false;
}

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (isAuthError(error)) {
      // Tag the error so page-level catch handlers can suppress their own
      // "Failed to load …" messages — the redirect below handles the UX.
      error.isAuthError = true;
      localStorage.removeItem('vegietrack_token');
      localStorage.removeItem('vegietrack_user');
      if (!window.location.pathname.endsWith('/login')) {
        window.location.href = '/login';
      }
    }
    return Promise.reject(error);
  }
);

export { isAuthError };

export default api;
