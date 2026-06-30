import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StatusBadge } from "../src/components/primitives/StatusBadge";

describe("StatusBadge", () => {
  it("shows loading state", () => {
    render(<StatusBadge connected={false} loading={true} />);
    expect(screen.getByText("Connecting…")).toBeInTheDocument();
  });

  it("shows connected state", () => {
    render(<StatusBadge connected={true} loading={false} />);
    expect(screen.getByText("Backend connected")).toBeInTheDocument();
  });

  it("shows offline state", () => {
    render(<StatusBadge connected={false} loading={false} />);
    expect(screen.getByText("Backend offline")).toBeInTheDocument();
  });
});
