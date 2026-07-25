import { Navigate, Route, Routes } from "react-router-dom";
import { useAuth } from "./lib/auth";
import { Spinner } from "./components/ui";
import Layout from "./components/Layout";
import LoginPage from "./pages/LoginPage";
import ForgotPasswordPage from "./pages/ForgotPasswordPage";
import ResetPasswordPage from "./pages/ResetPasswordPage";
import VerifyEmailPage from "./pages/VerifyEmailPage";
import DashboardPage from "./pages/DashboardPage";
import NewApplicationPage from "./pages/NewApplicationPage";
import ApplicationsPage from "./pages/ApplicationsPage";
import ApplicationPage from "./pages/ApplicationPage";
import ResumesPage from "./pages/ResumesPage";
import AnalyticsPage from "./pages/AnalyticsPage";
import SettingsPage from "./pages/SettingsPage";
import ProfilePage from "./pages/ProfilePage";
import WritingPage from "./pages/WritingPage";
import CoverLettersPage from "./pages/CoverLettersPage";
import CompaniesPage from "./pages/CompaniesPage";
import InterviewPage from "./pages/InterviewPage";
import CopilotPage from "./pages/CopilotPage";
import AdminPage from "./pages/AdminPage";
import OAuthCallbackPage from "./pages/OAuthCallbackPage";

function AuthedApp() {
  return (
    <Layout>
      <Routes>
        <Route path="/" element={<DashboardPage />} />
        <Route path="/new" element={<NewApplicationPage />} />
        <Route path="/applications" element={<ApplicationsPage />} />
        <Route path="/applications/:id" element={<ApplicationPage />} />
        <Route path="/resumes" element={<ResumesPage />} />
        <Route path="/profile" element={<ProfilePage />} />
        <Route path="/writing" element={<WritingPage />} />
        <Route path="/cover-letters" element={<CoverLettersPage />} />
        <Route path="/companies" element={<CompaniesPage />} />
        <Route path="/interview" element={<InterviewPage />} />
        <Route path="/copilot" element={<CopilotPage />} />
        <Route path="/admin" element={<AdminPage />} />
        <Route path="/analytics" element={<AnalyticsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/login" element={<Navigate to="/" replace />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Layout>
  );
}

export default function App() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner className="h-8 w-8" />
      </div>
    );
  }

  return (
    <Routes>
      {/* Email-driven flows work whether or not someone is signed in. */}
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="/reset-password" element={<ResetPasswordPage />} />
      <Route path="/verify-email" element={<VerifyEmailPage />} />
      {/* OAuth lands here with tokens in the fragment, signed in or not. */}
      <Route path="/oauth/callback" element={<OAuthCallbackPage />} />

      {user ? (
        <Route path="/*" element={<AuthedApp />} />
      ) : (
        <>
          <Route path="/login" element={<LoginPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </>
      )}
    </Routes>
  );
}
