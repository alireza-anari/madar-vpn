import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app/App';
import { registerServiceWorker } from './pwa/registerServiceWorker';
import './styles/global.css';

const root = document.getElementById('root');

if (!root) {
  throw new Error('Missing #root mount point');
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

registerServiceWorker();
