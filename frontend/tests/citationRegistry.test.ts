import { describe, expect, it } from "vitest";
import {
  CITATION_DB,
  getCitationsForPipelines,
  formatBibTeX,
  formatAPA,
  formatVancouver,
  formatRIS,
  formatCSLJSON,
} from "../src/lib/citationRegistry";

describe("CITATION_DB integrity", () => {
  it("has no duplicate keys", () => {
    const keys = CITATION_DB.map((c) => c.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("every entry has a non-empty DOI", () => {
    for (const c of CITATION_DB) {
      expect(c.doi.length, `${c.key} DOI missing`).toBeGreaterThan(0);
    }
  });

  it("every entry has authors and year", () => {
    for (const c of CITATION_DB) {
      expect(c.authors.length, `${c.key} authors missing`).toBeGreaterThan(0);
      expect(c.year, `${c.key} year missing`).toBeGreaterThan(2000);
    }
  });
});

describe("getCitationsForPipelines", () => {
  it("returns mriqc citation for mriqc pipeline", () => {
    const cits = getCitationsForPipelines(["mriqc"]);
    expect(cits.some((c) => c.key === "mriqc")).toBe(true);
  });

  it("returns fmriprep citation for import-fmriprep-derivatives", () => {
    const cits = getCitationsForPipelines(["import-fmriprep-derivatives"]);
    expect(cits.some((c) => c.key === "fmriprep")).toBe(true);
  });

  it("deduplicates when two pipelines share a citation", () => {
    const cits = getCitationsForPipelines(["mriqc", "mriqc-group"]);
    const mriqcCits = cits.filter((c) => c.key === "mriqc");
    expect(mriqcCits).toHaveLength(1);
  });

  it("returns empty array for unknown pipeline", () => {
    expect(getCitationsForPipelines(["totally-unknown"])).toHaveLength(0);
  });

  it("returns nilearn citation for functional-connectivity", () => {
    const cits = getCitationsForPipelines(["functional-connectivity"]);
    expect(cits.some((c) => c.key === "nilearn")).toBe(true);
  });

  it("returns multiple citations for multi-pipeline selection", () => {
    const cits = getCitationsForPipelines(["mriqc", "synthstrip", "fastsurfer"]);
    expect(cits.length).toBeGreaterThanOrEqual(3);
  });
});

describe("formatBibTeX", () => {
  it("produces a @article block for journal papers", () => {
    const bib = formatBibTeX(CITATION_DB.find((c) => c.key === "mriqc")!);
    expect(bib).toContain("@article{");
    expect(bib).toContain("doi");
    expect(bib).toContain("10.1371/journal.pone.0184661");
    expect(bib).toContain("RRID:SCR_022942");
  });

  it("produces @misc for software citations", () => {
    const bib = formatBibTeX(CITATION_DB.find((c) => c.key === "dcm2bids")!);
    expect(bib).toContain("@misc{");
  });

  it("includes volume when available", () => {
    const bib = formatBibTeX(CITATION_DB.find((c) => c.key === "fmriprep")!);
    expect(bib).toContain("volume");
  });
});

describe("formatAPA", () => {
  it("includes year in parentheses", () => {
    const apa = formatAPA(CITATION_DB.find((c) => c.key === "mriqc")!);
    expect(apa).toContain("(2017)");
  });

  it("includes doi URL", () => {
    const apa = formatAPA(CITATION_DB.find((c) => c.key === "mriqc")!);
    expect(apa).toContain("https://doi.org/10.1371/journal.pone.0184661");
  });

  it("handles software citations differently", () => {
    const apa = formatAPA(CITATION_DB.find((c) => c.key === "dcm2bids")!);
    expect(apa).toContain("[Software]");
  });
});

describe("formatVancouver", () => {
  it("starts with the provided index number", () => {
    const van = formatVancouver(CITATION_DB.find((c) => c.key === "mriqc")!, 3);
    expect(van).toMatch(/^3\./);
  });

  it("includes doi for journal citations", () => {
    const van = formatVancouver(CITATION_DB.find((c) => c.key === "synthstrip")!, 1);
    expect(van).toContain("doi:");
  });
});

describe("formatRIS", () => {
  it("produces TY and ER fields", () => {
    const ris = formatRIS([CITATION_DB.find((c) => c.key === "mriqc")!]);
    expect(ris).toContain("TY  -");
    expect(ris).toContain("ER  -");
  });

  it("outputs COMP type for software", () => {
    const ris = formatRIS([CITATION_DB.find((c) => c.key === "dcm2bids")!]);
    expect(ris).toContain("TY  - COMP");
  });

  it("includes RRID in note field", () => {
    const ris = formatRIS([CITATION_DB.find((c) => c.key === "fmriprep")!]);
    expect(ris).toContain("SCR_016216");
  });
});

describe("formatCSLJSON", () => {
  it("returns array of objects with type and DOI", () => {
    const csl = formatCSLJSON([CITATION_DB.find((c) => c.key === "nilearn")!]);
    expect(csl[0]).toMatchObject({ type: "article-journal", DOI: "10.3389/fninf.2014.00014" });
  });

  it("uses software type for software citations", () => {
    const csl = formatCSLJSON([CITATION_DB.find((c) => c.key === "dcm2bids")!]);
    expect((csl[0] as { type: string }).type).toBe("software");
  });
});
