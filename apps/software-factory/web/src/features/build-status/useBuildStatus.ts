import { useGetV1Build } from "@/api/generated";

// Modelled as a discriminated union (docs/writing-scalable-typescript,
// "01-impossible-states") rather than the react-query boolean soup
// (isLoading/isError/data all independently truthy), so a caller can switch
// exhaustively instead of guessing which flags can coexist.
export type BuildStatusState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; version: string };

// The one proving page (#553): fetches `/v1/build` through the generated
// client end to end , Go type -> OpenAPI -> Orval -> React , no hand-written
// fetch, no fixture. Polling cadence comes from the QueryClient default
// (src/queryClient.ts), not from an option here.
export function useBuildStatus(): BuildStatusState {
  const query = useGetV1Build();

  if (query.isPending) return { kind: "loading" };
  if (query.isError) {
    const message = query.error instanceof Error ? query.error.message : "unknown error";
    return { kind: "error", message };
  }
  return { kind: "ready", version: query.data.data.version };
}
