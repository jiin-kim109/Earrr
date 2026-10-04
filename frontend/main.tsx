import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import App from './app/App.js';
import { AppFailureBoundary } from './app/FailureToast.js';
import { Log } from './lib/log.js';
import './tailwind.css';

Log.initialize();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppFailureBoundary>
      <App />
    </AppFailureBoundary>
  </React.StrictMode>,
);
