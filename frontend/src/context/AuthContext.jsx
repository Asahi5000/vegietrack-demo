import { createContext, useContext, useState } from 'react';
import api from '../api/axios';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => {
    const stored = localStorage.getItem('vegietrack_user');
    if (!stored) return null;
    try {
      const savedUser = JSON.parse(stored);
      if (savedUser?.demo_mode === true) return savedUser;
    } catch {
      // Discard malformed persisted session data and require a new demo login.
    }
    localStorage.removeItem('vegietrack_token');
    localStorage.removeItem('vegietrack_user');
    return null;
  });
  const loading = false;

  const loginDemo = async () => {
    const res = await api.post('/auth/demo-login');
    const { token, user: userData } = res.data;
    localStorage.setItem('vegietrack_token', token);
    localStorage.setItem('vegietrack_user', JSON.stringify(userData));
    setUser(userData);
    return userData;
  };

  const logout = () => {
    localStorage.removeItem('vegietrack_token');
    localStorage.removeItem('vegietrack_user');
    setUser(null);
  };

  return (
    <AuthContext.Provider value={{ user, loginDemo, logout, loading }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}
