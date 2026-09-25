import React from 'react';
import ReactDOM from 'react-dom/client';
import AuthGate from './AuthGate';
import LiveViewer from './LiveViewer';
import './index.css';
import { readLiveTokenFromUrl } from './lib/liveMeetingApi';
import { applyTheme, getStoredTheme } from './lib/theme';

applyTheme(getStoredTheme());

// A shared Live Meeting link (?live=<token>) opens the standalone read-only viewer - no login, and none of the
// app's chats or sidebar are mounted. Everything else is the app exactly as before.
const liveToken = readLiveTokenFromUrl();

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {liveToken ? <LiveViewer shareToken={liveToken} /> : <AuthGate />}
  </React.StrictMode>
);
