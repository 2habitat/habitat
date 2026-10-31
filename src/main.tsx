import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from './app/App.tsx';
import { setQueryClient } from './services/api.ts';
import './styles/app.css';

const qc = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 2000,
      refetchOnWindowFocus: false,
      retry: 1,
    },
  },
});
setQueryClient(qc); // 写操作成功后由 API 层统一失效缓存，界面不会停在旧数据上

const el = document.getElementById('root');
if (!el) throw new Error('#root 不见了');

createRoot(el).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
