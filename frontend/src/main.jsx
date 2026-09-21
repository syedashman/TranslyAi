import React from 'react';
import ReactDOM from 'react-dom/client';
import AuthGate from './AuthGate';
import './index.css';
import { applyTheme, getStoredTheme } from './lib/theme';

applyTheme(getStoredTheme());

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthGate />
  </React.StrictMode>
);
