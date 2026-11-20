import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { LiveUpdatesProvider } from './hooks/LiveUpdatesProvider.jsx';
import './index.css';

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <LiveUpdatesProvider>
      <App />
    </LiveUpdatesProvider>
  </StrictMode>,
);
