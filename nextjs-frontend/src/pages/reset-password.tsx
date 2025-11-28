import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '@/components/Layout';
import { useAuth } from '@/hooks/useAuth';
import apiClient from '@/lib/api';

export default function ResetPassword() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  // For reset-with-token flow
  const [token, setToken] = useState<string | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [setPwdLoading, setSetPwdLoading] = useState(false);
  const [setPwdError, setSetPwdError] = useState('');
  const [setPwdSuccess, setSetPwdSuccess] = useState(false);
  
  const { resetPassword, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
    // If the URL contains a token query param, switch to set-password mode.
    // Also support token in hash fragment, path segment, or previously stored in sessionStorage
    if (typeof window !== 'undefined') {
      const readTokenFromUrl = () => {
        // returns { token, source }
        // 1) Query param ?token= or ?t=
        if (router.isReady) {
          const q = router.query?.token || router.query?.t || null;
          if (q && typeof q === 'string') return { token: q, source: 'query' };
        }

        // 2) Hash fragment like #token=...
        try {
          const hash = window.location.hash || '';
          if (hash) {
            const m = hash.match(/token=([^&]+)/);
            if (m && m[1]) return { token: decodeURIComponent(m[1]), source: 'hash' };
          }
        } catch (e) {}

        // 3) Path form /reset-password/<token>
        try {
          const parts = window.location.pathname.split('/').filter(Boolean);
          const last = parts[parts.length - 1] || '';
          if (last && last !== 'reset-password' && last.length >= 8) return { token: last, source: 'path' };
        } catch (e) {}

        // 4) sessionStorage fallback (preserve across redirects)
        try {
          const stored = sessionStorage.getItem('cx_reset_token');
          if (stored) return { token: stored, source: 'session' };
        } catch (e) {}

        return { token: null, source: null };
      };

      const { token: tokenFromUrl } = readTokenFromUrl();
      if (tokenFromUrl && typeof tokenFromUrl === 'string') {
        setToken(tokenFromUrl);
        try { sessionStorage.setItem('cx_reset_token', tokenFromUrl); } catch (e) {}
        return; // token found in URL - nothing else to do
      }

      // If no token in URL, rely on sessionStorage fallback (handled above in readTokenFromUrl)
      }
    if (user) {
      const target = '/';
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
    }
  }, [user, router]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');
    setSuccess(false);

    try {
      await resetPassword(email);
      setSuccess(true);
    } catch (error: any) {
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSetPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setSetPwdError('');
    setSetPwdSuccess(false);

    if (!token) {
      setSetPwdError('Reset token not found. Use the link from your email.');
      return;
    }

    if (!newPassword || newPassword.length < 8) {
      setSetPwdError('Password must be at least 8 characters long');
      return;
    }

    if (newPassword !== confirmPassword) {
      setSetPwdError('Passwords do not match');
      return;
    }

    try {
      setSetPwdLoading(true);
      await apiClient.post('/reset-password', { token, newPassword });
      setSetPwdSuccess(true);
      // Clear stored token on success
      try { sessionStorage.removeItem('cx_reset_token'); } catch (e) {}
    } catch (err: any) {
      setSetPwdError(err.response?.data?.error || err.message || 'Failed to reset password');
    } finally {
      setSetPwdLoading(false);
    }
  };

  useEffect(() => {
    document.body.className = 'auth-page';
    return () => {
      document.body.className = '';
    };
  }, [user, router]);

  if (success) {
    return (
      <Layout title="Password Reset - CXFlow Meeting Bot" showHeader={false}>
        <div className="auth-container">
            <div className="logo">
              <div style={{ fontSize: '48px', marginBottom: '8px' }}>
                <img 
                  src="https://www.cxflow.io/app/images/logo.png" 
                  alt="CXFlow Logo" 
                  style={{ width: '40px', height: '40px' }}
                />
              </div>
              <h1>Check Your Email</h1>
              <p>We've sent you a password reset link</p>
            </div>
            
            <div className="alert alert-success">
              We've sent a password reset link to <strong>{email}</strong>
            </div>
            
            <p style={{ textAlign: 'center', color: '#718096', fontSize: '14px', marginBottom: '24px' }}>
              Please check your email and click the link to reset your password. 
              If you don't see the email, check your spam folder.
            </p>
            
            <Link href="/signin">
              <button className="auth-btn">
                Back to Sign In
              </button>
            </Link>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Reset Password - CXFlow Meeting Bot" showHeader={false}>
      <div className="auth-container">
        {/* debug banner removed */}
        <div className="logo">
          <div style={{ fontSize: '48px', marginBottom: '8px' }}>
            <img 
              src="https://www.cxflow.io/app/images/logo.png" 
              alt="CXFlow Logo" 
              style={{ width: '40px', height: '40px' }}
              suppressHydrationWarning
            />
          </div>
          <h1>Reset Password</h1>
          <p>Enter your email address and we'll send you a link to reset your password.</p>
        </div>

        {/* If a token is present in the URL, show the set-password form */}
        {token ? (
          <>
            {setPwdError && <div className="alert alert-error">{setPwdError}</div>}

            {setPwdSuccess ? (
              <div>
                <div className="alert alert-success">Password reset successfully.</div>
                <div style={{ textAlign: 'center', marginTop: 16 }}>
                  <Link href="/signin">
                    <button className="auth-btn">Back to Sign In</button>
                  </Link>
                </div>
              </div>
            ) : (
              <form onSubmit={handleSetPassword}>
                <div className="auth-form-group">
                  <label htmlFor="newPassword">New Password</label>
                  <input
                    id="newPassword"
                    name="newPassword"
                    type="password"
                    placeholder="Enter new password"
                    value={newPassword}
                    onChange={(e) => { setNewPassword(e.target.value); setSetPwdError(''); }}
                    required
                    autoComplete="new-password"
                  />
                </div>

                <div className="auth-form-group">
                  <label htmlFor="confirmPassword">Confirm Password</label>
                  <input
                    id="confirmPassword"
                    name="confirmPassword"
                    type="password"
                    placeholder="Confirm new password"
                    value={confirmPassword}
                    onChange={(e) => { setConfirmPassword(e.target.value); setSetPwdError(''); }}
                    required
                    autoComplete="new-password"
                  />
                </div>

                <button type="submit" disabled={setPwdLoading} className="auth-btn">
                  {setPwdLoading ? 'Setting...' : 'Set New Password'}
                </button>
              </form>
            )}

            <div style={{ marginTop: 12, textAlign: 'center' }}>
              <Link href="/signin">Back to Sign In</Link>
            </div>
          </>
        ) : (
          <>
            {/* Error Alert */}
            {error && (
              <div className="alert alert-error">
                {error}
              </div>
            )}

            {/* Reset Password Form */}
            <form onSubmit={handleSubmit}>
              <div className="auth-form-group">
                <label htmlFor="email">Email Address</label>
                <input
                  id="email"
                  name="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setError('');
                  }}
                  required
                  autoComplete="email"
                />
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="auth-btn"
              >
                {isLoading ? 'Sending...' : 'Send Reset Link'}
              </button>
            </form>

            <div className="auth-links">
              <div style={{ marginBottom: '12px' }}>
                <Link href="/signin">
                  Back to Sign In
                </Link>
              </div>
              <div style={{ color: '#718096', fontSize: '14px' }}>
                Don't have an account?{' '}
                <Link href="/signup">
                  Sign up
                </Link>
              </div>
            </div>
          </>
        )}
      </div>
    </Layout>
  );
}

// Server-side detection of token so initial render can show set-password UI
// Removed getServerSideProps: client-side detection (query/hash/path/sessionStorage)
