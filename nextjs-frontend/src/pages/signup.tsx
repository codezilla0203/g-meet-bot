import React, { useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import Link from 'next/link';
import Layout from '@/components/Layout';
import { useAuth } from '@/hooks/useAuth';

export default function SignUp() {
  const [formData, setFormData] = useState({
    email: '',
    password: '',
    confirmPassword: '',
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [passwordStrength, setPasswordStrength] = useState(0);
  
  const { signup, user } = useAuth();
  const router = useRouter();

  useEffect(() => {
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

  const calculatePasswordStrength = (password: string) => {
    let strength = 0;
    if (password.length >= 8) strength += 1;
    if (/[a-z]/.test(password)) strength += 1;
    if (/[A-Z]/.test(password)) strength += 1;
    if (/[0-9]/.test(password)) strength += 1;
    if (/[^A-Za-z0-9]/.test(password)) strength += 1;
    return strength;
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    setError(''); // Clear error when user types
    
    if (name === 'password') {
      setPasswordStrength(calculatePasswordStrength(value));
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError('');

    // Validation
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      setIsLoading(false);
      return;
    }

    if (formData.password.length < 8) {
      setError('Password must be at least 8 characters long');
      setIsLoading(false);
      return;
    }

    try {
      const result = await signup(formData.email, formData.password);
      // Redirect to signin with success message
      if (result?.success) {
        setError(''); // Clear any errors
        // Redirect to signin page with message
        if (router.isReady) {
          router.replace('/signin?message=Account created successfully! Please check your email to verify your account.').catch((err) => {
            console.warn('Router navigation failed, using window.location:', err);
            window.location.href = '/signin?message=Account created successfully! Please check your email to verify your account.';
          });
        } else {
          window.location.href = '/signin?message=Account created successfully! Please check your email to verify your account.';
        }
      }
    } catch (error: any) {
      setError(error.message);
    } finally {
      setIsLoading(false);
    }
  };

  const getStrengthColor = () => {
    if (passwordStrength <= 2) return 'bg-red-400';
    if (passwordStrength <= 3) return 'bg-yellow-400';
    return 'bg-green-400';
  };

  const getStrengthText = () => {
    if (passwordStrength <= 2) return 'Weak';
    if (passwordStrength <= 3) return 'Medium';
    return 'Strong';
  };

  useEffect(() => {
    document.body.className = 'auth-page';
    return () => {
      document.body.className = '';
    };
  }, [user, router]);

  return (
    <Layout title="Sign Up - CXFlow Meeting Bot" showHeader={false}>
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
          <h1>Create Account</h1>
          <p>Join CXFlow Meeting Bot to start recording meetings</p>
        </div>

        {/* Error Alert */}
        {error && (
          <div className="alert alert-error">
            {error}
          </div>
        )}

        {/* Sign Up Form */}
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
              placeholder="Create a strong password"
              value={formData.password}
              onChange={handleInputChange}
              required
              autoComplete="new-password"
            />
            
            {/* Password Strength Indicator */}
            {formData.password && (
              <div>
                <div className="password-strength">
                  <div 
                    className={`password-strength-bar ${
                      passwordStrength <= 2 ? 'strength-weak' : 
                      passwordStrength <= 3 ? 'strength-medium' : 'strength-strong'
                    }`}
                  />
                </div>
                <div className="password-hint">
                  Must be at least 8 characters
                </div>
              </div>
            )}
          </div>

          <div className="auth-form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              id="confirmPassword"
              name="confirmPassword"
              type="password"
              placeholder="Re-enter your password"
              value={formData.confirmPassword}
              onChange={handleInputChange}
              required
              autoComplete="new-password"
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="auth-btn"
          >
            {isLoading ? 'Creating Account...' : 'Create Account'}
          </button>
        </form>

        <div className="auth-links">
          <div style={{ color: '#718096', fontSize: '14px' }}>
            Already have an account?{' '}
            <Link href="/signin">
              Sign in
            </Link>
          </div>
      </div>
      </div>
    </Layout>
  );
}
