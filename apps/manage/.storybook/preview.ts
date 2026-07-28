import type { Preview } from "@storybook/react-vite";
import "../src/styles/app.css";

const preview: Preview = {
  parameters: {
    // manage is black-only. A white canvas behind these components would be a
    // lie about how any of them ever render.
    backgrounds: { disable: true },
  },
  decorators: [
    (Story) => {
      document.body.style.background = "var(--bg)";
      return Story();
    },
  ],
};

export default preview;
