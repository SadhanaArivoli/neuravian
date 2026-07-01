import { Navigate, Route, Routes } from "react-router-dom";
import { Sidebar } from "./components/primitives/Sidebar";
import DatasetDetail from "./pages/DatasetDetail";
import Datasets from "./pages/Datasets";
import Pipelines from "./pages/Pipelines";
import RunDetail from "./pages/RunDetail";
import Runs from "./pages/Runs";

export default function App() {
  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <main className="flex-1 overflow-y-auto">
        <Routes>
          <Route path="/" element={<Navigate to="/datasets" replace />} />
          <Route path="/datasets" element={<Datasets />} />
          <Route path="/datasets/:id" element={<DatasetDetail />} />
          <Route path="/pipelines" element={<Pipelines />} />
          <Route path="/runs" element={<Runs />} />
          <Route path="/runs/:id" element={<RunDetail />} />
        </Routes>
      </main>
    </div>
  );
}
