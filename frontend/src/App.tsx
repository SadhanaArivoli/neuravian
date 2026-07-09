import { Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/primitives/Sidebar";
import DatasetDetail from "./pages/DatasetDetail";
import Datasets from "./pages/Datasets";
import Pipelines from "./pages/Pipelines";
import RunDetail from "./pages/RunDetail";
import Runs from "./pages/Runs";
import Welcome from "./pages/Welcome";
import WizardDcm2bids from "./pages/WizardDcm2bids";

export default function App() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Welcome />} />
          <Route path="/datasets" element={<Datasets />} />
          <Route path="/datasets/:id" element={<DatasetDetail />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
          <Route path="/wizard/dcm2bids" element={<WizardDcm2bids />} />
        </Routes>
      </main>
    </div>
  );
}
