import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import DashboardPage from "./pages/DashboardPage";
import NewApplicationPage from "./pages/NewApplicationPage";
import ApplicationPage from "./pages/ApplicationPage";
import ResumesPage from "./pages/ResumesPage";
import AnalyticsPage from "./pages/AnalyticsPage";

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-ink-200 border-t-ink-900" />
      </div>
    );
  }

  if (!user) {
    return (
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="*" element={<Navigate to="/login" replace />} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/new" element={<NewApplicationPage />} />
        <Route path="/applications/:id" element={<ApplicationPage />} />
        <Route path="/resumes" element={<ResumesPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}
