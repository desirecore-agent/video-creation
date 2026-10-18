import './lib/desirecore-host';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { FocusNav } from './components/FocusNav';
import './globals.css';
import { applyStudioHost } from './lib/host';
import { startHostAppearance } from './lib/host-appearance';
import { applySavedTheme } from './components/settings/theme';

applyStudioHost();
startHostAppearance(applySavedTheme);

createRoot(document.getElementById('root')!).render(<StrictMode><FocusNav /><App /></StrictMode>);
