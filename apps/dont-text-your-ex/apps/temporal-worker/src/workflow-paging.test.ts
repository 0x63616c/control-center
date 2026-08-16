import { describe, expect, it } from "vitest";
import { nextPagingDecision } from "./workflow-paging";

describe("bounded workflow paging", () => {
  it("continues as new after twenty full 500-row pages", () => {
    expect(nextPagingDecision({ pageSize: 500, pageCount: 20, processed: 500 })).toBe(
      "continue_as_new",
    );
  });
  it("finishes after a partial page", () => {
    expect(nextPagingDecision({ pageSize: 500, pageCount: 1, processed: 42 })).toBe("complete");
  });
});
