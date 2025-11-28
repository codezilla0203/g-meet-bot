# CXFlow Meeting Bot - Next.js Frontend

A modern, responsive frontend for the CXFlow Meeting Bot application built with Next.js, TypeScript, and Tailwind CSS.

## 🚀 Features

- **Modern UI/UX**: Clean, professional interface with Tailwind CSS
- **Authentication**: Complete auth flow with signin, signup, and password reset
- **Bot Management**: Create, monitor, and manage meeting bots
- **Configuration**: Comprehensive settings for bot behavior and webhooks
- **Meeting Recordings**: Shareable meeting recordings with transcript and audio
- **Responsive Design**: Works perfectly on desktop and mobile devices
- **TypeScript**: Full type safety throughout the application
- **Real-time Updates**: Auto-refreshing bot status and data

## 📁 Project Structure

```
nextjs-frontend/
├── src/
│   ├── components/          # Reusable UI components
│   │   ├── Layout.tsx       # Main layout wrapper
│   │   ├── Tabs.tsx         # Tab navigation component
│   │   ├── CreateBot.tsx    # Bot creation form
│   │   ├── MyBots.tsx       # Bot management interface
│   │   └── Configuration.tsx # Settings page
│   ├── hooks/               # Custom React hooks
│   │   └── useAuth.ts       # Authentication logic
│   ├── lib/                 # Utility libraries
│   │   └── api.ts           # API client and functions
│   ├── pages/               # Next.js pages
│   │   ├── _app.tsx         # App wrapper with providers
│   │   ├── index.tsx        # Main dashboard
│   │   ├── signin.tsx       # Sign in page
│   │   ├── signup.tsx       # Sign up page
│   │   ├── reset-password.tsx # Password reset
│   │   └── share.tsx        # Meeting recording viewer
│   └── styles/
│       └── globals.css      # Global styles and Tailwind
├── public/                  # Static assets
├── package.json
├── tailwind.config.js
├── tsconfig.json
└── next.config.js
```

## 🛠️ Installation & Setup

### Prerequisites

- Node.js 18+ 
- npm or yarn
- Your existing backend server running on port 3000

### 1. Install Dependencies

```bash
cd nextjs-frontend
npm install
```

### 2. Environment Setup

The frontend is configured to proxy API requests to your existing backend server running on `http://localhost:3000`. 

If your backend runs on a different port, update the `next.config.js` file:

```javascript
async rewrites() {
  return [
    {
      source: '/api/:path*',
      destination: 'http://localhost:YOUR_BACKEND_PORT/:path*',
    },
  ]
},
```

### 3. Start Development Server

```bash
npm run dev
```

The frontend will be available at `http://localhost:3001` (or the next available port).

### 4. Build for Production

```bash
npm run build
npm start
```

## 🎨 Key Components

### Authentication System
- **JWT-based authentication** with secure cookie storage
- **Auto token refresh** and expiration handling
- **Protected routes** with automatic redirects
- **Password strength validation** on signup

### Dashboard Features
- **Create Bot Tab**: Form to create new meeting bots with all options
- **My Bots Tab**: List and manage existing bots with real-time status
- **Configuration Tab**: Comprehensive settings for bot behavior

### Meeting Recordings
- **Shareable links** for meeting recordings
- **Audio player** with playback controls
- **Searchable transcript** with speaker identification
- **Speaker talktime analysis** with visual charts

## 🔧 Configuration Options

The Configuration tab includes:

- **Bot Name**: Customize the bot's display name
- **Webhook URL**: Endpoint for meeting events and data
- **Summary Template**: Custom AI prompts for meeting summaries
- **Bot Logo**: Custom logo for the bot
- **Recording Limits**: Time limits and quota management

## 📱 Responsive Design

The application is fully responsive with:
- **Mobile-first design** approach
- **Adaptive layouts** for different screen sizes
- **Touch-friendly** interface elements
- **Optimized performance** on all devices

## 🔒 Security Features

- **Secure authentication** with JWT tokens
- **CSRF protection** with SameSite cookies
- **Input validation** on all forms
- **XSS prevention** with proper sanitization
- **Secure API communication** with automatic token handling

## 🎯 API Integration

The frontend integrates with your existing backend through:

- **Automatic API proxying** via Next.js rewrites
- **Centralized API client** with error handling
- **Authentication interceptors** for secure requests
- **Type-safe API calls** with TypeScript interfaces

## 🚀 Deployment

### Vercel (Recommended)
```bash
npm install -g vercel
vercel
```

### Docker
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "start"]
```

### Manual Deployment
```bash
npm run build
npm start
```

## 🔄 Migration from HTML/JS

This Next.js frontend is a complete conversion of your existing HTML/JavaScript application with:

- ✅ **All existing functionality** preserved and enhanced
- ✅ **Modern React architecture** with hooks and components
- ✅ **TypeScript** for better development experience
- ✅ **Tailwind CSS** for consistent, maintainable styling
- ✅ **Improved performance** with Next.js optimizations
- ✅ **Better SEO** with server-side rendering capabilities
- ✅ **Enhanced developer experience** with hot reload and debugging

## 📞 Support

For questions or issues:
1. Check the existing backend API documentation
2. Ensure your backend server is running and accessible
3. Verify the API proxy configuration in `next.config.js`
4. Check browser console for any JavaScript errors

## 🎉 Ready to Use!

Your Next.js frontend is now ready! It provides a modern, professional interface for your CXFlow Meeting Bot with all the features from your original application plus enhanced user experience, better performance, and maintainable code structure.
