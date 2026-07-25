import * as React from "react";
import { TileStatus } from "../../ui";

type TileArgType = Record<string, unknown>;

type TileMeta<C> = {
  title: string;
  component: C;
  tags: string[];
  argTypes?: Record<string, TileArgType>;
};

/**
 * Shared argType for the standard loading/populated/error discriminator.
 * Tiles that expose a `status` prop should spread this into their argTypes
 * rather than re-declaring it inline.
 */
const TILE_STATUS_ARG_TYPE: TileArgType = {
  control: "radio",
  options: Object.values(TileStatus),
  description: "Data load state  --  loading/error renders a shimmer skeleton",
};

/**
 * Factory for a labeled boolean toggle argType (online, live, etc.).
 * Pass a human-readable description so each tile's intent is clear in Storybook.
 */
export function boolArgType(description: string): TileArgType {
  return { control: "boolean", description };
}

/**
 * Returns the standard Meta fields shared by every tile story.
 * Grid sizing is applied automatically by the global BoardDecorator in
 * preview.tsx via registryEntryForComponent  --  no per-story config needed.
 * Pass extra tags (e.g. "a11y") in additionalTags to merge with "autodocs".
 */
export function defineTileMeta<C>(
  name: string,
  component: C,
  additionalTags: string[] = [],
): TileMeta<C> {
  return {
    title: `Tiles/${name}` as const,
    component,
    tags: ["autodocs", ...additionalTags],
    argTypes: {
      status: TILE_STATUS_ARG_TYPE,
    },
  };
}

/**
 * Docs parameters for modal stories  --  spread into a modal meta's `parameters`.
 *
 * WHY: modals render through `Modal`, which `createPortal`s to <body> as a
 * `position: fixed; inset: 0` full-viewport overlay with a dim backdrop. On an
 * autodocs page every story renders at once, so inline modals escape their
 * Canvas, stack on top of each other, and bury the page (args table + sibling
 * stories) behind compounding backdrops. Rendering each modal story in its OWN
 * iframe (`docs.story.inline: false`) scopes every overlay to its frame so the
 * Docs page reads correctly (www-hljb follow-up).
 *
 * Returned as plain `parameters` (NOT a full meta) so each modal keeps an
 * explicit, statically-analyzable `title` literal  --  Storybook's CSF indexer
 * can't extract a title hidden behind a factory spread, which silently drops
 * the story from the index.
 *
 * `docsHeight` tunes the per-story iframe height (defaults to a tall panel).
 */
export function modalDocsParameters(docsHeight = 880) {
  return { docs: { story: { inline: false, height: `${docsHeight}px` } } };
}

/**
 * Decorator wrapping a story in a page-sized container standing in for
 * TileDetailHost's content region (the flex:1/minHeight:0/overflowY:auto div
 * that hosts full-page tile detail bodies).
 *
 * Pass an explicit `heightPx` for components that flex-fill their container
 * (e.g. AllAppsModal, #66) , without a definite height, a flex-fill child has
 * nothing to fill and the story can't demonstrate fill-to-bottom behavior.
 * Omit it for components that size themselves (the historical `100vh`
 * fallback), matching the copy-pasted decorator this factors out.
 */
export function pageHostDecorator(heightPx?: number) {
  return (Story: React.ComponentType) =>
    React.createElement(
      "div",
      {
        style: {
          ...(heightPx === undefined ? { minHeight: "100vh" } : { height: `${heightPx}px` }),
          display: "flex",
          flexDirection: "column",
          background: "var(--bg)",
          padding: 24,
          boxSizing: "border-box",
        },
      },
      React.createElement(Story),
    );
}
