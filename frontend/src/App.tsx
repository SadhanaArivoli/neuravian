import { Route, Routes } from "react-router-dom";
import { OnboardingProvider } from "./context/OnboardingContext";
import { OnboardingOverlay } from "./components/onboarding/OnboardingOverlay";
import { Sidebar } from "./components/primitives/Sidebar";
import ComparisonStudio from "./pages/ComparisonStudio";
import DatasetDetail from "./pages/DatasetDetail";
import Datasets from "./pages/Datasets";
import Pipelines from "./pages/Pipelines";
import RemoteHosts from "./pages/RemoteHosts";
import RunDetail from "./pages/RunDetail";
import ArtifactExplorer from "./pages/ArtifactExplorer";
import DatasetDashboard from "./pages/DatasetDashboard";
import MethodsStudio from "./pages/MethodsStudio";
import WorkflowGraph from "./pages/WorkflowGraph";
import Runs from "./pages/Runs";
import ReportStudio from "./pages/ReportStudio";
import ReportViewer from "./pages/ReportViewer";
import ReportCompare from "./pages/ReportCompare";
import StatisticalMapExplorer from "./pages/StatisticalMapExplorer";
import Projects from "./pages/Projects";
import ProjectDetail from "./pages/ProjectDetail";
import Settings from "./pages/Settings";
import Welcome from "./pages/Welcome";
import WorkflowBuilder from "./pages/WorkflowBuilder";
import WorkflowLibrary from "./pages/WorkflowLibrary";
import WizardDcm2bids from "./pages/WizardDcm2bids";

export default function App() {
  return (
    <OnboardingProvider>
      <div className="flex min-h-screen flex-col overflow-hidden md:h-screen md:flex-row">
        <Sidebar />
        <main className="min-h-0 flex-1 overflow-y-auto">
          <Routes>
            <Route path="/" element={<Welcome />} />
            <Route path="/projects" element={<Projects />} />
            <Route path="/projects/:id" element={<ProjectDetail />} />
            <Route path="/datasets" element={<Datasets />} />
            <Route path="/datasets/:id" element={<DatasetDetail />} />
            <Route path="/pipelines" element={<Pipelines />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/workflows/new" element={<WorkflowBuilder />} />
            <Route path="/workflows/library" element={<WorkflowLibrary />} />
            <Route path="/wizard/dcm2bids" element={<WizardDcm2bids />} />
            <Route path="/compare" element={<ComparisonStudio />} />
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
          </Routes>
        </main>
      </div>
      <OnboardingOverlay />
    </OnboardingProvider>
  );
}
