import { Navigate, Outlet, Route, Routes, useSearchParams } from 'react-router';

import Layout from './Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { ScrollToTop } from './components/ScrollToTop';
import { useAuth } from './contexts/AuthContext';
import { AuthProvider } from './contexts/AuthProvider';
import { KeysProvider } from './contexts/KeysContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { IndexPage } from './pages/Index';
import Links from './pages/Links';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import Plan from './pages/Plan';
import Privacy from './pages/Privacy';
import Push from './pages/Push';
import { ResetPassword } from './pages/ResetPassword';
import { Security } from './pages/Security';
import Support from './pages/Support';
import Terms from './pages/Terms';
import { ViewPush } from './pages/ViewPush';
import { VIEW_PARAM } from './services/viewable';

function IndexOrRedirect() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;

  if (isAuthenticated) {
    return <Navigate to="/links" replace />;
  }

  return <IndexPage />;
}

/**
 * The extension's page is `index.html`, which is sent home. With `?view=<push id>` it is
 * where an image push is shown: the extension's worker opens it for an image pushed to this
 * browser (chrome/background.ts), and the list links to it, on the site as in the extension.
 * Then the image is all the tab holds, as a pushed image's Storage URL was before
 * encryption. The address stays as it was opened, rather than moving to a route of its own,
 * because a reload asks the extension for that path as a file and only `index.html` is one;
 * staying here, a reload decrypts the image again.
 */
function ImagePageOrHome() {
  const [params] = useSearchParams();
  const view = params.get(VIEW_PARAM);
  if (!view) return <Navigate to="/" replace />;
  return (
    <ProtectedRoute>
      <ViewPush pushId={view} />
    </ProtectedRoute>
  );
}

function App() {
  return (
    <AuthProvider>
      <KeysProvider>
        <ThemeProvider>
          <Routes>
            {/* Outside `Layout`: a pushed image opens on its own, with nothing of the site around it. */}
            <Route path="/index.html" element={<ImagePageOrHome />} />
            <Route
              element={
                <Layout>
                  <ScrollToTop />
                  <Outlet />
                </Layout>
              }
            >
              <Route path="/login" element={<Login />} />
              <Route path="/" element={<IndexOrRedirect />} />
              <Route path="/privacy" element={<Privacy />} />
              <Route path="/terms" element={<Terms />} />
              <Route path="/support" element={<Support />} />
              <Route path="/security" element={<Security />} />
              <Route path="/reset" element={<ResetPassword />} />
              <Route element={<ProtectedRoute />}>
                <Route path="/links" element={<Links />} />
                <Route path="/push" element={<Push />} />
                <Route path="/plan" element={<Plan />} />
              </Route>
              <Route path="*" element={<NotFound />} />
            </Route>
          </Routes>
        </ThemeProvider>
      </KeysProvider>
    </AuthProvider>
  );
}

export default App;
