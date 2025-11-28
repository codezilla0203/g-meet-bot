import React from 'react';
import Head from 'next/head';
import { LogOut } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';

interface LayoutProps {
  children: React.ReactNode;
  title?: string;
  showHeader?: boolean;
}

export default function Layout({ children, title = 'CXFlow Meeting Bot', showHeader = true }: LayoutProps) {
  const { user, logout } = useAuth();

  return (
    <>
      <Head>
        <title>{title}</title>
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="min-h-screen bg-gray-100">
        {showHeader && (
          <header style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 16px', background: '#0f172a', color: '#fff' }}>
            <h1 className="layout-header-title" style={{ margin: 0, display: 'flex', alignItems: 'center', gap: '8px', fontWeight: 600 }}>
              <img 
                src="https://www.cxflow.io/app/images/logo.png" 
                alt="CXFlow Logo" 
                style={{ width: '28px', height: '28px', verticalAlign: 'middle' }}
                suppressHydrationWarning
              />
              <span style={{ lineHeight: 1 }}>{'CXFlow Meeting Bot'}</span>
            </h1>

            {user && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
                <span className="layout-user-email">{user.email}</span>
                <button
                  onClick={logout}
                  className="btn-secondary layout-logout-button"
                >
                  Logout
                </button>
              </div>
            )}
          </header>
        )}

        <main>
          {children}
        </main>
      </div>
    </>
  );
}
