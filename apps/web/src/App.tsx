import { Navigate, Route, Routes } from 'react-router';

import Layout from './Layout';
import { ScrollToTop } from './components/ScrollToTop';
import ProtectedRoute from './components/ProtectedRoute';
import { AuthProvider } from './contexts/AuthContext';
import { useAuth } from './contexts/AuthContext';
import { ThemeProvider } from './contexts/ThemeContext';
import Links from './pages/Links';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import Plan from './pages/Plan';
import Privacy from './pages/Privacy';
import Push from './pages/Push';
import { ResetPassword } from './pages/ResetPassword';
import Support from './pages/Support';
import Terms from './pages/Terms';
import { IndexPage } from './pages/Index';

function IndexOrRedirect() {
  const { isAuthenticated, loading } = useAuth();

  if (loading) return null;

  if (isAuthenticated) {
    return <Navigate to="/links" replace />;
  }

  return <IndexPage />;
}

function App() {
  return (
    <AuthProvider>
      <ThemeProvider>
        <Layout>
          <ScrollToTop />
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/" element={<IndexOrRedirect />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/support" element={<Support />} />
            <Route path="/reset" element={<ResetPassword />} />
            <Route element={<ProtectedRoute />}>
              <Route path="/links" element={<Links />} />
              <Route path="/push" element={<Push />} />
              <Route path="/plan" element={<Plan />} />
            </Route>
            <Route path="/index.html" element={<Navigate to="/" />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Layout>
      </ThemeProvider>
    </AuthProvider>
  );
}

export default App;
