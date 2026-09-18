import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminPage } from './pages/AdminPage.js';
import { FunnelPage } from './pages/FunnelPage.js';
import { SuccessPage } from './pages/SuccessPage.js';
import { initTracking } from './tracking/index.js';
import { ErrorBoundary } from './components/ErrorBoundary.js';

export function App() {
  // Initialise the Pixel once, before any route renders an event.
  useEffect(() => {
    initTracking();
  }, []);

  return (
    <ErrorBoundary>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<FunnelPage />} />
          <Route path="/success" element={<SuccessPage />} />
          <Route path="/admin" element={<AdminPage />} />
          {/* Any unknown path drops the user into the funnel rather than a 404 -
              paid traffic sometimes arrives on malformed URLs and a dead end
              there is pure wasted spend. */}
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
