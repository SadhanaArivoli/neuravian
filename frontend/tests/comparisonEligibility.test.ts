import { describe, expect, it } from "vitest";
import {
  classifyEligibility,
  computeDice,
  findVerifiedSibling,
  geometriesCompatible,
  sortByEligibility,
  type NiftiGeometry,
} from "../src/lib/comparisonEligibility";
import type { RunSummary } from "../src/api/client";

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeRun(overrides: Partial<RunSummary> & { id: number }): RunSummary {
  return {
    pipeline_manifest_id: "brainchop",
    pipeline_version: "1.0",
    dataset_id: 7,
    status: "success",
    source_run_id: null,
    started_at: null,
    finished_at: null,
    created_at: "2025-01-01T00:00:00Z",
    ...overrides,
  };
}

// Mirrors the real runs in dev:
// Run #26 = dcm2niix (the common ancestor)
// Run #34 = brainchop (no lineage stored — old run)
// Run #40 = synthstrip (source_run_id=26)
const run26 = makeRun({ id: 26, pipeline_manifest_id: "dcm2niix", source_run_id: null });
const run34 = makeRun({ id: 34, pipeline_manifest_id: "brainchop", source_run_id: null });
const run40 = makeRun({ id: 40, pipeline_manifest_id: "synthstrip", source_run_id: 26 });

// ── classifyEligibility ────────────────────────────────────────────────────────

describe("classifyEligibility — verified siblings (shared source_run_id)", () => {
  it("qualifies two runs that share the same non-null source_run_id", () => {
    const runA = makeRun({ id: 1, pipeline_manifest_id: "brainchop", source_run_id: 26 });
    const runB = makeRun({ id: 2, pipeline_manifest_id: "synthstrip", source_run_id: 26 });
    const result = classifyEligibility(runA, runB);
    expect(result.tier).toBe("verified");
    expect(result.reason).toContain("run #26");
  });

  it("run #40 (SynthStrip, source=26) is verified sibling of a hypothetical brainchop run with source=26", () => {
    const hypoChop = makeRun({ id: 99, pipeline_manifest_id: "brainchop", source_run_id: 26 });
    const result = classifyEligibility(run40, hypoChop);
    expect(result.tier).toBe("verified");
  });
});

describe("classifyEligibility — verified parent-child", () => {
  it("qualifies when candidate was derived from ref (candidate.source_run_id === ref.id)", () => {
    const result = classifyEligibility(run26, run40);
    expect(result.tier).toBe("verified");
    expect(result.reason).toContain("run #40");
  });

  it("qualifies when ref was derived from candidate (ref.source_run_id === candidate.id)", () => {
    const result = classifyEligibility(run40, run26);
    expect(result.tier).toBe("verified");
  });
});

describe("classifyEligibility — unverified (same dataset, no lineage)", () => {
  it("run #34 (no lineage) vs run #40 (has lineage) → unverified, same dataset", () => {
    const result = classifyEligibility(run34, run40);
    expect(result.tier).toBe("unverified");
    expect(result.reason).toContain("lineage unverified");
  });

  it("two runs with null source_run_id on same dataset → unverified", () => {
    const a = makeRun({ id: 1, source_run_id: null });
    const b = makeRun({ id: 2, source_run_id: null });
    const result = classifyEligibility(a, b);
    expect(result.tier).toBe("unverified");
  });
});

describe("classifyEligibility — ineligible", () => {
  it("rejects comparing a run to itself", () => {
    const result = classifyEligibility(run34, run34);
    expect(result.tier).toBe("ineligible");
  });

  it("rejects runs from different datasets", () => {
    const a = makeRun({ id: 1, dataset_id: 7 });
    const b = makeRun({ id: 2, dataset_id: 99 });
    const result = classifyEligibility(a, b);
    expect(result.tier).toBe("ineligible");
    expect(result.reason).toContain("Different datasets");
  });

  it("does NOT treat two runs with different non-null source_run_ids as verified siblings", () => {
    const a = makeRun({ id: 1, source_run_id: 26 });
    const b = makeRun({ id: 2, source_run_id: 99 }); // different ancestor
    const result = classifyEligibility(a, b);
    // They share the same dataset_id so fall through to unverified
    expect(result.tier).toBe("unverified");
  });
});

// ── sortByEligibility ─────────────────────────────────────────────────────────

describe("sortByEligibility", () => {
  it("verified options sort before unverified", () => {
    const ref = makeRun({ id: 50, source_run_id: 26 });
    const verifiedOpt = { run: makeRun({ id: 40, pipeline_manifest_id: "synthstrip", source_run_id: 26 }) };
    const unverifiedOpt = { run: makeRun({ id: 34, pipeline_manifest_id: "brainchop", source_run_id: null }) };
    const sorted = sortByEligibility(ref, [unverifiedOpt, verifiedOpt]);
    expect(sorted[0].run.id).toBe(40); // verified first
    expect(sorted[1].run.id).toBe(34); // unverified second
  });

  it("excludes ineligible (different dataset) runs", () => {
    const ref = makeRun({ id: 1, dataset_id: 7 });
    const wrong = { run: makeRun({ id: 2, dataset_id: 99 }) };
    const sorted = sortByEligibility(ref, [wrong]);
    expect(sorted).toHaveLength(0);
  });
});

// ── findVerifiedSibling ────────────────────────────────────────────────────────

describe("findVerifiedSibling", () => {
  it("returns the single verified sibling when exactly one exists", () => {
    const ref = makeRun({ id: 40, pipeline_manifest_id: "synthstrip", source_run_id: 26 });
    const sibling = makeRun({ id: 99, pipeline_manifest_id: "brainchop", source_run_id: 26 });
    const result = findVerifiedSibling(ref, [sibling]);
    expect(result?.id).toBe(99);
  });

  it("returns null when no verified sibling exists", () => {
    const result = findVerifiedSibling(run40, [run34]); // run34 has no lineage → unverified
    expect(result).toBeNull();
  });

  it("returns null when multiple verified siblings exist (ambiguous)", () => {
    const ref = makeRun({ id: 1, source_run_id: 26, pipeline_manifest_id: "synthstrip" });
    const s1 = makeRun({ id: 2, source_run_id: 26, pipeline_manifest_id: "brainchop" });
    const s2 = makeRun({ id: 3, source_run_id: 26, pipeline_manifest_id: "brainchop2" });
    const result = findVerifiedSibling(ref, [s1, s2]);
    expect(result).toBeNull();
  });

  it("excludes runs from the same pipeline", () => {
    const ref = makeRun({ id: 1, source_run_id: 26, pipeline_manifest_id: "synthstrip" });
    const samePipeline = makeRun({ id: 2, source_run_id: 26, pipeline_manifest_id: "synthstrip" });
    const result = findVerifiedSibling(ref, [samePipeline]);
    expect(result).toBeNull();
  });
});

// ── computeDice ────────────────────────────────────────────────────────────────

describe("computeDice", () => {
  it("Dice = 1.0 for identical non-empty masks", () => {
    const mask = new Uint8Array([0, 1, 1, 1, 0]);
    const { dice, intersection, aOnly, bOnly } = computeDice(mask, mask.slice());
    expect(dice).toBeCloseTo(1.0);
    expect(intersection).toBe(3);
    expect(aOnly).toBe(0);
    expect(bOnly).toBe(0);
  });

  it("Dice = 0 for completely disjoint masks", () => {
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([0, 0, 1, 1]);
    const { dice } = computeDice(a, b);
    expect(dice).toBeCloseTo(0.0);
  });

  it("Dice = 0.5 for 50% overlap", () => {
    // a = [1,1,0,0], b = [0,1,1,0] → intersection=1, aOnly=1, bOnly=1
    // Dice = 2*1 / (2*1+1+1) = 2/4 = 0.5
    const a = new Uint8Array([1, 1, 0, 0]);
    const b = new Uint8Array([0, 1, 1, 0]);
    const { dice, intersection, aOnly, bOnly } = computeDice(a, b);
    expect(dice).toBeCloseTo(0.5);
    expect(intersection).toBe(1);
    expect(aOnly).toBe(1);
    expect(bOnly).toBe(1);
  });

  it("Dice = 0 for two all-zero masks (no foreground)", () => {
    const z = new Uint8Array([0, 0, 0]);
    const { dice, totalForeground } = computeDice(z, z.slice());
    expect(dice).toBe(0);
    expect(totalForeground).toBe(0);
  });

  it("throws on length mismatch", () => {
    const a = new Uint8Array([1, 1]);
    const b = new Uint8Array([1]);
    expect(() => computeDice(a, b)).toThrow("length mismatch");
  });
});

// ── geometriesCompatible ──────────────────────────────────────────────────────

describe("geometriesCompatible", () => {
  const base: NiftiGeometry = {
    dims: [274, 384, 384],
    pixdim: [1.0, 1.0, 1.0],
    datatype: 2,
    qformCode: 1,
    sformCode: 1,
  };

  it("returns true for identical geometries", () => {
    expect(geometriesCompatible(base, { ...base })).toBe(true);
  });

  it("returns false when dimensions differ", () => {
    expect(geometriesCompatible(base, { ...base, dims: [256, 256, 256] })).toBe(false);
  });

  it("returns false when voxel spacing differs beyond tolerance", () => {
    expect(
      geometriesCompatible(base, { ...base, pixdim: [1.0, 1.5, 1.0] })
    ).toBe(false);
  });

  it("returns true when voxel spacing differs within tolerance (< 0.001 mm)", () => {
    expect(
      geometriesCompatible(base, { ...base, pixdim: [1.0, 1.0, 1.0009] })
    ).toBe(true);
  });

  it("disables Dice when geometry mismatch: dimension difference blocks comparison", () => {
    const a: NiftiGeometry = { ...base, dims: [274, 384, 384] };
    const b: NiftiGeometry = { ...base, dims: [256, 256, 256] };
    expect(geometriesCompatible(a, b)).toBe(false);
  });
});
