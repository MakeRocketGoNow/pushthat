import { Navigate, Outlet, Route, Routes, useLocation, useSearchParams } from 'react-router';

import Layout from './Layout';
import ProtectedRoute from './components/ProtectedRoute';
import { ScrollToTop } from './components/ScrollToTop';
import { useAuth } from './contexts/AuthContext';
import { AuthProvider } from './contexts/AuthProvider';
import { KeysProvider } from './contexts/KeysContext';
import { ThemeProvider } from './contexts/ThemeContext';
import { Account } from './pages/Account';
import { IndexPage } from './pages/Index';
import Links from './pages/Links';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import Push from './pages/Push';
import { ResetPassword } from './pages/ResetPassword';
import { ViewPush } from './pages/ViewPush';
import { VIEW_PARAM } from './services/viewable';
import { STATIC_PAGES } from './staticPages';

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

/**
 * `/plan`, the Plan page's address before it became the first section of Account. Stripe's
 * checkout returns here with `?checkout=complete` and its portal returns here
 * (functions/src/stripe-functions.ts, `planPageUrl`, and the portal's configuration), so the
 * query goes along: the plan section reads it to confirm a subscription on arrival. Kept
 * for old bookmarks once those point at `/account` too.
 */
function PlanRedirect() {
  const { search } = useLocation();
  return <Navigate to={{ pathname: '/account', search }} replace />;
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
              {STATIC_PAGES.map(({ path, Page }) => (
                <Route key={path} path={path} element={<Page />} />
              ))}
              <Route path="/reset" element={<ResetPassword />} />
              <Route element={<ProtectedRoute />}>
                <Route path="/links" element={<Links />} />
                <Route path="/push" element={<Push />} />
                <Route path="/account" element={<Account />} />
                <Route path="/plan" element={<PlanRedirect />} />
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
