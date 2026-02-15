import { useState, useEffect, createContext, useContext, type ReactNode } from 'react';
import { api } from '../lib/api';

interface User {
  id: string;
  name: string;
  email?: string;
  avatar?: string;
}

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  isAuthenticated: boolean;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps): JSX.Element {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    checkAuth();
  }, []);

  async function checkAuth(): Promise<void> {
    try {
      const data = await api.auth.me() as User;
      setUser(data);
    } catch (err) {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  async function logout(): Promise<void> {
    try {
      await api.auth.logout();
    } finally {
      setUser(null);
    }
  }

  const value: AuthContextValue = {
    user,
    loading,
    isAuthenticated: !!user,
    logout,
    checkAuth,
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default useAuth;
