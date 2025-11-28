import { useState, useEffect, createContext, useContext } from 'react';
import { useRouter } from 'next/router';
import Cookies from 'js-cookie';
import { apiClient } from '@/lib/api';

interface User {
  email: string;
}

interface AuthContextType {
  user: User | null;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<{ success: boolean; message?: string; emailSent?: boolean }>;
  logout: () => void;
  resetPassword: (email: string) => Promise<void>;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export function useAuthProvider(): AuthContextType {
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const router = useRouter();

  useEffect(() => {
    checkAuth();
  }, []);

  const checkAuth = async () => {
    try {
      const token = Cookies.get('auth_token');
      const email = Cookies.get('user_email');
      
      if (token && email) {
        // Verify token is still valid
        if (!isTokenExpired(token)) {
          setUser({ email });
        } else {
          clearAuth();
        }
      }
    } catch (error) {
      console.error('Auth check failed:', error);
      clearAuth();
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string) => {
    try {
      const response = await apiClient.post('/login', { email, password });
      const { token } = response.data;
      
      Cookies.set('auth_token', token, { expires: 7 });
      Cookies.set('user_email', email, { expires: 7 });
      
      setUser({ email });
      
      // Use replace instead of push to avoid history issues
      // Add a small delay to ensure state is updated
      await new Promise(resolve => setTimeout(resolve, 100));
      
      const target = '/';
      if (router.isReady) {
        // Only navigate if we're not already at the target
        if (router.asPath !== target && router.pathname !== target) {
          router.replace(target).catch((err) => {
            console.warn('Router navigation failed, using window.location:', err);
            try {
              if (typeof window !== 'undefined' && window.location.pathname !== target) {
                window.location.href = target;
              }
            } catch (e) {
              console.warn('Failed to fallback to window.location', e);
            }
          });
        }
      } else {
        // If router is not ready, use window.location only if different
        if (typeof window !== 'undefined' && window.location.pathname !== target) {
          window.location.href = target;
        }
      }
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Login failed');
    }
  };

  const signup = async (email: string, password: string) => {
    try {
      const response = await apiClient.post('/signup', { email, password });
      // Don't automatically log in - user needs to verify email first
      // Return success message for the UI to handle
      return response.data;
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Signup failed');
    }
  };

  const logout = () => {
    clearAuth();
    // Use replace to avoid adding to history
    const target = '/signin';
    if (router.isReady) {
      if (router.asPath !== target && router.pathname !== target) {
        router.replace(target).catch((err) => {
          console.warn('Router navigation failed, using window.location:', err);
          try {
            if (typeof window !== 'undefined' && window.location.pathname !== target) {
              window.location.href = target;
            }
          } catch (e) {
            console.warn('Failed to fallback to window.location', e);
          }
        });
      }
    } else {
      if (typeof window !== 'undefined' && window.location.pathname !== target) {
        window.location.href = target;
      }
    }
  };

  const resetPassword = async (email: string) => {
    try {
      const response = await apiClient.post('/forgot-password', { email });
      // If API responds with explicit failure, throw so UI can show error
      if (response?.data && response.data.success === false) {
        throw new Error(response.data.error || 'Failed to send reset email');
      }
    } catch (error: any) {
      throw new Error(error.response?.data?.error || 'Reset password failed');
    }
  };

  const clearAuth = () => {
    Cookies.remove('auth_token');
    Cookies.remove('user_email');
    setUser(null);
  };

  const isTokenExpired = (token: string): boolean => {
    try {
      const payload = JSON.parse(atob(token.split('.')[1]));
      return payload.exp * 1000 < Date.now();
    } catch {
      return true;
    }
  };

  return {
    user,
    login,
    signup,
    logout,
    resetPassword,
    isLoading,
  };
}

export { AuthContext };
