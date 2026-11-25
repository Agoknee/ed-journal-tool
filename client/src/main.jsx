import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import AuthGate from './components/AuthGate.jsx';
import { LiveUpdatesProvider } from './hooks/LiveUpdatesProvider.jsx';
import './index.css';

// Live updates start only once the API can be used (see AuthGate).
createRoot(document.getElementById('root')).render(
  <StrictMode>
    <AuthGate>
      <LiveUpdatesProvider>
        <App />
      </LiveUpdatesProvider>
    </AuthGate>
  </StrictMode>,
);
