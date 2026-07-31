import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Preview } from "@storybook/react-vite";
import { createElement } from "react";
import "../src/styles/app.css";

// Every story renders inside a QueryClientProvider: any component that calls
// a generated react-query hook (e.g. TranscriptViewer, collapsed or not)
// needs one in its tree just to construct, the same way main.tsx wraps the
// real App. retry is off so an inevitable-in-Storybook failed fetch (there is
// no API behind Storybook) resolves to an error state immediately instead of
// retrying for real time.
const preview: Preview = {
  decorators: [
    (Story) => {
      const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      return createElement(QueryClientProvider, { client: queryClient }, createElement(Story));
    },
  ],
};

export default preview;
