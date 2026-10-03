import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource-variable/instrument-sans';
import App from './app/App.js';
import './tailwind.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
