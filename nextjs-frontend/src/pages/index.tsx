import React, { useEffect, useState } from 'react';
import { useRouter } from 'next/router';
import Layout from '@/components/Layout';
import Tabs from '@/components/Tabs';
import CreateBot from '@/components/CreateBot';
import MyBots from '@/components/MyBots';
import Configuration from '@/components/Configuration';
import { useAuth } from '@/hooks/useAuth';
import { ArrowLeft } from 'lucide-react';

export default function Home() {
  const { user, isLoading } = useAuth();
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('create-bot');
  const [isBotDetailView, setIsBotDetailView] = useState(false);

  useEffect(() => {
    if (!isLoading && !user) {
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
    }
  }, [user, isLoading, router]);

  if (isLoading) {
    return (
      <Layout>
        <div className="flex items-center justify-center min-h-[400px]">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-500"></div>
        </div>
      </Layout>
    );
  }

  if (!user) {
    return null; // Will redirect to signin
  }

  const handleBackToList = () => {
    setIsBotDetailView(false);
    // Trigger the back handler in MyBots component
    if ((window as any).__myBotsBackHandler) {
      (window as any).__myBotsBackHandler();
    }
  };

  const tabs = [
    {
      id: 'create-bot',
      label: 'Create Bot',
      content: <CreateBot />,
    },
    {
      id: 'my-bots',
      label: 'My Bots',
      content: <MyBots onBotDetailView={setIsBotDetailView} onBackRequest={handleBackToList} />,
    },
    {
      id: 'configuration',
      label: 'Configuration',
      content: <Configuration isActive={activeTab === 'configuration'} />,
    },
  ];

  return (
    <Layout title="CXFlow Meeting Bot - Dashboard">
      <Tabs 
        tabs={tabs} 
        defaultTab="create-bot" 
        onTabChange={setActiveTab}
        rightSideElement={
          isBotDetailView && activeTab === 'my-bots' ? (
            <button
              onClick={handleBackToList}
              style={{
                background: '#f3f4f6',
                color: '#374151',
                border: 'none',
                padding: '8px 12px',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 500,
                fontFamily: "'Poppins', sans-serif",
                transition: 'background-color 0.2s ease',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '6px',
                marginLeft: 'auto',
                flexShrink: 0
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.background = '#e5e7eb';
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = '#f3f4f6';
              }}
              className="back-button-responsive"
            >
              <ArrowLeft size={16} />
              <span className="back-button-text">Back to List</span>
            </button>
          ) : null
        }
      />
    </Layout>
  );
}
