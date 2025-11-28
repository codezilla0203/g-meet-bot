import '@/styles/globals.css';
import '@/styles/auth.css';
import '@/styles/share.css';
import '@/styles/components.css';
import type { AppProps } from 'next/app';
import { AuthContext, useAuthProvider } from '@/hooks/useAuth';

function AuthProvider({ children }: { children: React.ReactNode }) {
  const auth = useAuthProvider();
  return <AuthContext.Provider value={auth}>{children}</AuthContext.Provider>;
}

export default function App({ Component, pageProps }: AppProps) {
  return (
    <AuthProvider>
      <Component {...pageProps} />
    </AuthProvider>
  );
}
