import { describe, expect, it } from "vitest";
import { shouldPollRun } from "../src/hooks/useRuns";

describe("shouldPollRun", () => {
  it.each(["pending", "queued", "running"])("polls while a run is %s", (status) => {
    expect(shouldPollRun(status)).toBe(true);
  });

  it.each(["success", "failed", "cancelled", undefined])(
    "stops polling when a run is %s",
    (status) => {
      expect(shouldPollRun(status)).toBe(false);
    },
  );
});
