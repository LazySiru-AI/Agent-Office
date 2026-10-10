import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.js';
import { applyBootTheme } from './theme/boot.js';
import './styles.css';

// Before React mounts, not inside it (FR-U1). The stylesheet is written entirely
// against `--ao-*` custom properties, so until they exist every rule resolves to
// nothing and the first paint is unstyled — a white flash on the way into a
// near-black app, which is exactly the thing a dark theme must not do.
applyBootTheme();

const rootEl = document.getElementById('root');
if (rootEl === null) {
  throw new Error('#root element missing from index.html');
}

createRoot(rootEl).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
