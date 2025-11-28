import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '@/components/Layout';
import { useAuth } from '@/hooks/useAuth';

export default function SignIn() {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');
  
  const { login, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // Only navigate if user is logged in and we're not already on the home page
    if (user && router.pathname !== '/') {
      // Add a small delay to ensure state is stable
      const timer = setTimeout(() => {
        if (router.isReady && router.pathname !== '/') {
          router.replace('/').catch((err) => {
            // If router navigation fails, use window.location as fallback
            if (err?.message?.includes('Abort') || err?.message?.includes('cancelled')) {
              // Navigation was cancelled, try again with window.location
              window.location.href = '/';
            } else {
              console.warn('Router navigation failed, using window.location:', err);
              window.location.href = '/';
            }
          });
        } else if (router.pathname !== '/') {
          window.location.href = '/';
        }
      }, 150);
      
      return () => clearTimeout(timer);
    }
    
    // Check for message from signup redirect
    if (router.query.message) {
      setSuccessMessage(router.query.message as string);
      // Clear the query parameter from URL
      router.replace('/signin', undefined, { shallow: true }).catch(() => {
        // Ignore errors for shallow routing
      });
    }
  }, [user, router]);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(''); // Clear error when user types
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    try {
      await login(formData.email, formData.password);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    document.body.className = 'auth-page';
    return () => {
      document.body.className = '';
    };
  }, []);

  return (
    <Layout title="Sign In - CXFlow Meeting Bot" showHeader={false}>
      <div className="auth-container">
        <div className="logo">
          <div style={{ fontSize: '48px', marginBottom: '8px' }}>
            <img 
              src="https://www.cxflow.io/app/images/logo.png" 
              alt="CXFlow Logo" 
              style={{ width: '40px', height: '40px' }}
              suppressHydrationWarning
            />
          </div>
          <h1>Sign In</h1>
          <p>Access your CXFlow Meeting Bot dashboard</p>
        </div>

        {/* Error Alert */}
        {successMessage && (
          <div className="alert alert-success" style={{ backgroundColor: '#d4edda', color: '#155724', borderColor: '#c3e6cb' }}>
            {successMessage}
          </div>
        )}
        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        {/* Sign In Form */}
        <form onSubmit={handleSubmit}>
          <div className="auth-form-group">
            <label htmlFor="email">Email Address</label>
            <input
              id="email"
              name="email"
              type="email"
              placeholder="you@example.com"
              value={formData.email}
              onChange={handleInputChange}
              required
              autoComplete="email"
            />
          </div>

          <div className="auth-form-group">
            <label htmlFor="password">Password</label>
            <input
              id="password"
              name="password"
              type="password"
              placeholder="Enter your password"
              value={formData.password}
              onChange={handleInputChange}
              required
              autoComplete="current-password"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="auth-btn"
          >
            {isLoading ? 'Signing In...' : 'Sign In'}
          </button>
        </form>

        <div className="divider">
          <span>or</span>
        </div>

        <div className="auth-links">
          <div style={{ marginBottom: '12px' }}>
            <Link href="/reset-password">
              Forgot your password?
            </Link>
          </div>
          <div style={{ color: '#718096', fontSize: '14px' }}>
            Don't have an account?{' '}
            <Link href="/signup">
              Sign up
            </Link>
          </div>
        </div>
        </div>
    </Layout>
  );
}
