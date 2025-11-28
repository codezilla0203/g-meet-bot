import React, { useState } from 'react';
import { clsx } from 'clsx';

interface Tab {
  id: string;
  label: string;
  content: React.ReactNode;
}

interface TabsProps {
  tabs: Tab[];
  defaultTab?: string;
  onTabChange?: (tabId: string) => void;
  rightSideElement?: React.ReactNode;
}

export default function Tabs({ tabs, defaultTab, onTabChange, rightSideElement }: TabsProps) {
  const [activeTab, setActiveTab] = useState(defaultTab || tabs[0]?.id);

  const handleTabChange = (tabId: string) => {
    setActiveTab(tabId);
    onTabChange?.(tabId);
  };

  const activeTabContent = tabs.find(tab => tab.id === activeTab)?.content;

  return (
    <div>
      {/* Tab Navigation */}
      <div className="tabs-container">
        <div className="tabs-wrapper">
          <div className="tabs">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={clsx(
                  'tab',
                  activeTab === tab.id && 'active'
                )}
              >
                {tab.label}
              </button>
            ))}
          </div>
          {rightSideElement && (
            <div className="tabs-right-element">
              {rightSideElement}
            </div>
          )}
        </div>
      </div>

      {/* Tab Content */}
      <div>
        {activeTabContent}
      </div>
    </div>
  );
}
