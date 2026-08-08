import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { Toaster } from 'react-hot-toast';
import App from './App.tsx';
import { AuthProvider } from './lib/auth.tsx';
import { initDataMode } from './lib/supabase.ts';
import './index.css';

// Antes de renderizar, detecta se as tabelas enriquecedor_* existem no banco
// do SalesHub (modo banco) ou se ficamos em modo local (localStorage).
initDataMode().finally(() => {
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <AuthProvider>
        <App />
        <Toaster position="top-right" />
      </AuthProvider>
    </StrictMode>,
  );
});
