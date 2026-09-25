import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';

import '../popup/styles.css';
import { App } from './App.js';

const container = document.querySelector('#root');
if (container !== null) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
