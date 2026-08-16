const MAX_PAGES_PER_RUN = 20;

export function nextPagingDecision(
  input: Readonly<{
    pageSize: number;
    pageCount: number;
    processed: number;
  }>,
): "next_page" | "continue_as_new" | "complete" {
  if (input.processed < input.pageSize) return "complete";
  return input.pageCount >= MAX_PAGES_PER_RUN ? "continue_as_new" : "next_page";
}
