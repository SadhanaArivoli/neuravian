import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { DatasetImportForm } from "../src/components/domain/DatasetImportForm";

// Mock the API client so tests don't hit the network
vi.mock("../src/api/client", () => ({
  registerDataset: vi.fn(),
  fetchDatasets: vi.fn().mockResolvedValue([]),
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

describe("DatasetImportForm", () => {
  it("renders the path input and import button", () => {
    render(<DatasetImportForm />, { wrapper });
    expect(screen.getByPlaceholderText(/absolute\/path/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /import/i })).toBeInTheDocument();
  });

  it("disables the import button when input is empty", () => {
    render(<DatasetImportForm />, { wrapper });
    expect(screen.getByRole("button", { name: /import/i })).toBeDisabled();
  });

  it("enables the button after typing a path", async () => {
    const user = userEvent.setup();
    render(<DatasetImportForm />, { wrapper });
    await user.type(screen.getByPlaceholderText(/absolute\/path/i), "/some/path");
    expect(screen.getByRole("button", { name: /import/i })).toBeEnabled();
  });

  it("calls registerDataset on submit and shows result", async () => {
    const { registerDataset } = await import("../src/api/client");
    vi.mocked(registerDataset).mockResolvedValueOnce({
      id: 1,
      name: "my-dataset",
      path: "/some/path",
      validation_status: "valid",
      bids_version: "1.9.0",
      subject_count: 2,
      created_at: "2026-06-30T00:00:00",
      updated_at: "2026-06-30T00:00:00",
      validation_issues: { errors: [], warnings: [] },
      indexed_metadata: null,
    });

    const user = userEvent.setup();
    render(<DatasetImportForm />, { wrapper });
    await user.type(screen.getByPlaceholderText(/absolute\/path/i), "/some/path");
    await user.click(screen.getByRole("button", { name: /import/i }));

    await waitFor(() =>
      expect(screen.getByText(/valid bids dataset/i)).toBeInTheDocument()
    );
    expect(registerDataset).toHaveBeenCalledWith("/some/path");
  });

  it("shows error message on API failure", async () => {
    const { registerDataset } = await import("../src/api/client");
    vi.mocked(registerDataset).mockRejectedValueOnce(
      new Error("Path does not exist")
    );

    const user = userEvent.setup();
    render(<DatasetImportForm />, { wrapper });
    await user.type(screen.getByPlaceholderText(/absolute\/path/i), "/bad/path");
    await user.click(screen.getByRole("button", { name: /import/i }));

    await waitFor(() =>
      expect(screen.getByText(/path does not exist/i)).toBeInTheDocument()
    );
  });
});
