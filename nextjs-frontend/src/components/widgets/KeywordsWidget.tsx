import React from 'react';

interface KeywordsWidgetProps {
  keywords?: string[] | { [key: string]: number };
}

export default function KeywordsWidget({ keywords }: KeywordsWidgetProps) {
  const renderKeywords = () => {
    if (!keywords) {
      return '<span class="no-keywords">No keywords found</span>';
    }

    let keywordList: string[] = [];
    if (Array.isArray(keywords)) {
      keywordList = keywords;
    } else if (typeof keywords === 'object') {
      keywordList = Object.keys(keywords).sort((a, b) => 
        (keywords as { [key: string]: number })[b] - (keywords as { [key: string]: number })[a]
      );
    }

    if (keywordList.length === 0) {
      return '<span class="no-keywords">No keywords found</span>';
    }

    const keywordColors = [
      '#a78bfa', '#86efac', '#fca5a5', '#fde047',
      '#93c5fd', '#f9a8d4', '#c4b5fd', '#6ee7b7'
    ];

    return keywordList.map((keyword, index) => {
      const color = keywordColors[index % keywordColors.length];
      return `<span class="keyword-tag" style="background-color: ${color};">${keyword}</span>`;
    }).join('');
  };

  return (
    <div className="keywords-section">
      <div className="keywords-tags" style={{ fontSize: '14px', color: '#6b7280' }} dangerouslySetInnerHTML={{ __html: renderKeywords() }} />
    </div>
  );
}

