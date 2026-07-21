import { lazy, Suspense } from "react";
import { Link, Navigate, Route, Routes } from "react-router-dom";
import { OnboardingProvider } from "./context/OnboardingContext";
import { OnboardingOverlay } from "./components/onboarding/OnboardingOverlay";
import { Sidebar } from "./components/primitives/Sidebar";
import DatasetDetail from "./pages/DatasetDetail";
import Datasets from "./pages/Datasets";
import Pipelines from "./pages/Pipelines";
import RemoteHosts from "./pages/RemoteHosts";
import Runs from "./pages/Runs";
import ProjectDetail from "./pages/ProjectDetail";
import Plugins from "./pages/Plugins";
import Settings from "./pages/Settings";
import Welcome from "./pages/Welcome";
import WorkflowLibrary from "./pages/WorkflowLibrary";
import Workspaces from "./pages/Workspaces";
import { WorkspaceProvider } from "./context/WorkspaceContext";

const ArtifactExplorer = lazy(() => import("./pages/ArtifactExplorer"));
const ComparisonStudio = lazy(() => import("./pages/ComparisonStudio"));
const DatasetDashboard = lazy(() => import("./pages/DatasetDashboard"));
const MethodsStudio = lazy(() => import("./pages/MethodsStudio"));
const Projects = lazy(() => import("./pages/Projects"));
const ReportCompare = lazy(() => import("./pages/ReportCompare"));
const ReportStudio = lazy(() => import("./pages/ReportStudio"));
const ReportViewer = lazy(() => import("./pages/ReportViewer"));
const RunDetail = lazy(() => import("./pages/RunDetail"));
const StatisticalMapExplorer = lazy(() => import("./pages/StatisticalMapExplorer"));
const WorkflowBuilder = lazy(() => import("./pages/WorkflowBuilder"));
const WorkflowGraph = lazy(() => import("./pages/WorkflowGraph"));
const WizardDcm2bids = lazy(() => import("./pages/WizardDcm2bids"));

function RouteLoading() {
  return (
    <div role="status" aria-live="polite" className="flex min-h-[50vh] items-center justify-center gap-3 text-sm text-gray-400">
      <span aria-hidden="true" className="h-4 w-4 animate-spin rounded-full border-2 border-accent border-t-transparent" />
      Loading workspace…
    </div>
  );
}

export default function App() {
  return (
    <OnboardingProvider>
      <WorkspaceProvider>
        <div className="flex min-h-screen flex-col overflow-hidden md:h-screen md:flex-row">
          <Sidebar />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <Suspense fallback={<RouteLoading />}>
              <Routes>
            <Route path="/" element={<Welcome />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/workspaces" element={<Workspaces />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/datasets" element={<Datasets />} />
            <Route path="/datasets/:id" element={<DatasetDetail />} />
            <Route path="/pipelines" element={<Pipelines />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/workflows" element={<Navigate to="/workflows/library" replace />} />
            <Route path="/workflows/new" element={<WorkflowBuilder />} />
            <Route path="/workflows/library" element={<WorkflowLibrary />} />
            <Route path="/wizard/dcm2bids" element={<WizardDcm2bids />} />
            <Route path="/compare" element={<ComparisonStudio />} />
            <Route path="/plugins" element={<Plugins />} />
            <Route path="/settings/remote-hosts" element={<RemoteHosts />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/datasets/:id/graph" element={<WorkflowGraph />} />
            <Route path="/datasets/:id/dashboard" element={<DatasetDashboard />} />
            <Route path="/datasets/:id/artifacts" element={<ArtifactExplorer />} />
            <Route path="/datasets/:id/methods" element={<MethodsStudio />} />
            <Route path="/datasets/:id/stat-maps" element={<StatisticalMapExplorer />} />
            <Route path="/datasets/:id/reports" element={<ReportStudio />} />
            <Route path="/datasets/:id/reports/compare" element={<ReportCompare />} />
            <Route path="/datasets/:id/reports/:reportId" element={<ReportViewer />} />
            <Route path="*" element={
              <div className="flex flex-col items-center justify-center h-full gap-4 text-center px-6">
                <p className="text-5xl font-bold text-gray-700">404</p>
                <p className="text-lg text-gray-400">Page not found</p>
                <Link to="/" className="text-sm text-accent hover:underline">← Back to Home</Link>
              </div>
            } />
              </Routes>
            </Suspense>
          </main>
        </div>
      </WorkspaceProvider>
      {!window.neuroforgeDesktop && <OnboardingOverlay />}
    </OnboardingProvider>
  );
}
