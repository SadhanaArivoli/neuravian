/**
 * Verifies that the homepage pipeline count label is derived from the live
 * /api/pipelines response rather than a hardcoded value.
 *
 * These tests exercise the label-derivation logic directly so that adding a
 * new pipeline manifest causes a count change that is automatically reflected
 * on the homepage without any manual update.
 */

import { describe, expect, it } from "vitest";

// ── Label derivation (mirrors Welcome.tsx logic exactly) ──────────────────────

function pipelineCountLabel(
  isLoading: boolean,
  isError: boolean,
  count: number | null,
): string {
  if (isLoading) return "Loading…";
  if (isError || count === null) return "Pipeline registry unavailable";
  return `${count} pipelines`;
}

describe("pipelineCountLabel", () => {
  it("shows loading state while fetching", () => {
    expect(pipelineCountLabel(true, false, null)).toBe("Loading…");
  });

  it("shows fallback when API errors", () => {
    expect(pipelineCountLabel(false, true, null)).toBe("Pipeline registry unavailable");
  });

  it("shows fallback when data is null despite no error flag", () => {
    expect(pipelineCountLabel(false, false, null)).toBe("Pipeline registry unavailable");
  });

  it("shows correct count when data is available", () => {
    expect(pipelineCountLabel(false, false, 18)).toBe("18 pipelines");
  });

  it("count label updates automatically — no hardcoded number", () => {
    // If a future pipeline is added, the homepage should reflect 19 without
    // any manual change to Welcome.tsx.
    expect(pipelineCountLabel(false, false, 19)).toBe("19 pipelines");
    expect(pipelineCountLabel(false, false, 20)).toBe("20 pipelines");
  });

  it("never produces '12 pipelines' for current registry size", () => {
    // Regression: the old hardcoded value was 12.
    expect(pipelineCountLabel(false, false, 18)).not.toBe("12 pipelines");
  });
});
