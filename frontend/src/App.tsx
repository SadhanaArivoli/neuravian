import { Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/primitives/Sidebar";
import ComparisonStudio from "./pages/ComparisonStudio";
import DatasetDetail from "./pages/DatasetDetail";
import Datasets from "./pages/Datasets";
import Pipelines from "./pages/Pipelines";
import RemoteHosts from "./pages/RemoteHosts";
import RunDetail from "./pages/RunDetail";
import ArtifactExplorer from "./pages/ArtifactExplorer";
import DatasetDashboard from "./pages/DatasetDashboard";
import WorkflowGraph from "./pages/WorkflowGraph";
import Runs from "./pages/Runs";
import Welcome from "./pages/Welcome";
import WorkflowBuilder from "./pages/WorkflowBuilder";
import WizardDcm2bids from "./pages/WizardDcm2bids";

export default function App() {
  return (
    <div className="flex min-h-screen flex-col overflow-hidden md:h-screen md:flex-row">
      <Sidebar />
      <main className="min-h-0 flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/datasets" element={<Datasets />} />
          <Route path="/datasets/:id" element={<DatasetDetail />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/workflows/new" element={<WorkflowBuilder />} />
          <Route path="/wizard/dcm2bids" element={<WizardDcm2bids />} />
          <Route path="/compare" element={<ComparisonStudio />} />
          <Route path="/settings/remote-hosts" element={<RemoteHosts />} />
          <Route path="/datasets/:id/graph" element={<WorkflowGraph />} />
          <Route path="/datasets/:id/dashboard" element={<DatasetDashboard />} />
          <Route path="/datasets/:id/artifacts" element={<ArtifactExplorer />} />
        </Routes>
      </main>
    </div>
  );
}
