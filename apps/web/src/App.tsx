import { Navigate, Route, Routes, useSearchParams } from 'react-router';

import Layout from './Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { ScrollToTop } from './components/ScrollToTop';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/AuthContext';
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

function IndexOrRedirect() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;

  if (isAuthenticated) {
    return <Navigate to="/links" replace />;
  }

  return <IndexPage />;
}

/**
 * The extension's page is `index.html`, which is sent home. The extension's worker opens it
 * with `?view=<push id>` to show an image pushed to this browser (chrome/background.ts),
 * since a path of the extension's other than a file it ships would not load.
 */
function ExtensionPage() {
  const [params] = useSearchParams();
  const view = params.get('view');
  return <Navigate to={view ? `/view?${new URLSearchParams({ push: view })}` : '/'} replace />;
}

function App() {
  return (
    <AuthProvider>
      <KeysProvider>
        <ThemeProvider>
          <Layout>
            <ScrollToTop />
            <Routes>
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
                <Route path="/view" element={<ViewPush />} />
              </Route>
              <Route path="/index.html" element={<ExtensionPage />} />
              <Route path="*" element={<NotFound />} />
            </Routes>
          </Layout>
        </ThemeProvider>
      </KeysProvider>
    </AuthProvider>
  );
}

export default App;
