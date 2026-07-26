/**
 * Stories for ExpandedControlsView , the expanded controls surface.
 * View-driven (all data + callbacks via props), mirroring ControlsTileView.stories.
 * Play functions double as component-test assertions via addon-vitest.
 *
 * The component is a bare page body now (hosted by TileDetailHost in the app),
 * so stories mount it inside a plain page-sized container matching the host's
 * content region.
 */

import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn, userEvent, waitFor, within } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import type { ControlsViewData } from "./ControlsTileView";
import { ExpandedControlsView } from "./ExpandedControlsView";

// ─── fixtures ─────────────────────────────────────────────────────────────────

const allOn: ControlsViewData = {
  lamps: { on: true, sub: "On", pending: false, brightness: 72, activeScene: null },
  lights: { on: true, pending: false },
  fan: { on: true, sub: "Medium", pending: false },
};

const lampsOff: ControlsViewData = {
  lamps: { on: false, pending: false },
  lights: { on: true, pending: false },
  fan: { on: false, pending: false },
};

// www-91bl: lamps OFF but the last-known level persists (the API now reports the
// desired brightness even when off). The bar must stay at that level, greyed out,
// not drop to 0% , so turning lamps back on resumes where they were.
const lampsOffAtLevel: ControlsViewData = {
  lamps: { on: false, pending: false, brightness: 100, activeScene: null },
  lights: { on: true, pending: false },
  fan: { on: false, pending: false },
};

const blueActive: ControlsViewData = {
  ...allOn,
  lamps: { ...allOn.lamps, activeScene: "blue" },
};

const partyActive: ControlsViewData = {
  ...allOn,
  lamps: { ...allOn.lamps, activeScene: "party" },
};

// ─── meta ─────────────────────────────────────────────────────────────────────

const meta = {
  title: "Modals/ExpandedControls",
  component: ExpandedControlsView,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    data: allOn,
    onToggle: fn(),
    onScene: fn(),
    onBrightness: fn(),
    onPartySelect: fn(),
  },
} satisfies Meta<typeof ExpandedControlsView>;

export default meta;
type Story = StoryObj<typeof meta>;

// ─── All on ───────────────────────────────────────────────────────────────────

export const Open: Story = {
  name: "Open , all on",
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    // Grid toggles are reused, no "More" button inside the modal
    await expect(canvas.getByLabelText("Lamps")).toBeInTheDocument();
    expect(canvas.queryByLabelText("More")).toBeNull();
    // All four scene tiles present, laid out as a 2-col ControlTap grid.
    const sceneGrid = canvas.getByRole("button", { name: "White" }).parentElement as HTMLElement;
    expect(sceneGrid.style.display).toBe("grid");
    expect(sceneGrid.style.gridTemplateColumns).toBe("1fr 1fr");
    for (const name of ["White", "Mood", "Red", "Blue"]) {
      const tile = canvas.getByRole("button", { name });
      expect(tile).toBeInTheDocument();
      // Each tile carries a ControlTap color swatch so the scene reads at a glance.
      expect(tile.querySelector("[data-swatch]")).not.toBeNull();
    }
    // Party is now a full-width Off/Slow/Med/Fast control, not a scene tile.
    expect(canvas.getByRole("tablist", { name: "Party" })).toBeInTheDocument();
    expect(canvas.getByRole("tab", { name: "Off" })).toHaveAttribute("aria-selected", "true");
    // No scene is active in this fixture → no tile highlighted.
    expect(canvas.getByRole("button", { name: "Blue" })).toHaveAttribute("aria-pressed", "false");
    // Brightness enabled when lamps on, seeded from data.lamps.brightness (72%).
    const slider = canvas.getByLabelText("Brightness") as HTMLInputElement;
    expect(slider).not.toBeDisabled();
    expect(slider.value).toBe("72");
    expect(canvas.getByText("72%")).toBeInTheDocument();
  },
};

// ─── Lamps off , slider disabled ──────────────────────────────────────────────

export const LampsOff: Story = {
  name: "Lamps off , slider disabled",
  args: { data: lampsOff },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    // HA rejects brightness on an off light, so the slider is a dead control
    await expect(canvas.getByLabelText("Brightness")).toBeDisabled();
    // Party needs a lamp lit , the control is disabled when all lamps are off.
    expect(canvas.getByRole("tablist", { name: "Party" })).toHaveStyle({ pointerEvents: "none" });
    expect(canvas.getByRole("tab", { name: "Fast" })).toBeDisabled();
  },
};

// ─── Lamps off but level retained (www-91bl) ───────────────────────────────────

export const LampsOffKeepsLevel: Story = {
  name: "Lamps off , bar greyed at last level (www-91bl)",
  args: { data: lampsOffAtLevel },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const slider = canvas.getByLabelText("Brightness") as HTMLInputElement;
    // Greyed/disabled while off (HA rejects brightness on an off light)...
    await expect(slider).toBeDisabled();
    // ...but the bar KEEPS the last-known level (100%), it does NOT drop to 0%.
    expect(slider.value).toBe("100");
    expect(slider.style.getPropertyValue("--p")).toBe("100%");
    expect(canvas.getByText("100%")).toBeInTheDocument();
  },
};

// ─── Scene interaction ────────────────────────────────────────────────────────

export const SceneInteraction: Story = {
  name: "Interaction , scene buttons fire onScene",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    await userEvent.click(canvas.getByRole("button", { name: "White" }));
    expect(args.onScene).toHaveBeenCalledWith("white");
    await userEvent.click(canvas.getByRole("button", { name: "Mood" }));
    expect(args.onScene).toHaveBeenCalledWith("mood");
    await userEvent.click(canvas.getByRole("button", { name: "Red" }));
    expect(args.onScene).toHaveBeenCalledWith("red");
    await userEvent.click(canvas.getByRole("button", { name: "Blue" }));
    expect(args.onScene).toHaveBeenCalledWith("blue");
  },
};

// ─── Active scene highlight ─────────────────────────────────────────────────

export const BlueActive: Story = {
  name: "Active scene , Blue highlighted",
  args: { data: blueActive },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    // The Blue scene tile is highlighted (on); the others are not.
    await expect(canvas.getByRole("button", { name: "Blue" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    for (const name of ["White", "Mood", "Red"]) {
      expect(canvas.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
  },
};

// ─── Party active ─────────────────────────────────────────────────────────────

export const PartyActive: Story = {
  name: "Party mode active",
  args: { data: partyActive, speed: "medium" },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    // The active speed segment lights (seeded at Medium); Off is not selected.
    await expect(canvas.getByRole("tab", { name: "Med" })).toHaveAttribute("aria-selected", "true");
    expect(canvas.getByRole("tab", { name: "Off" })).toHaveAttribute("aria-selected", "false");
    // No scene tile is active while party runs.
    for (const name of ["White", "Mood", "Red", "Blue"]) {
      expect(canvas.getByRole("button", { name })).toHaveAttribute("aria-pressed", "false");
    }
    // Picking a new speed fires onPartySelect with that speed.
    await userEvent.click(canvas.getByRole("tab", { name: "Fast" }));
    expect(args.onPartySelect).toHaveBeenCalledWith("fast");
    // Tapping Off fires onPartySelect('off') (stops party).
    await userEvent.click(canvas.getByRole("tab", { name: "Off" }));
    expect(args.onPartySelect).toHaveBeenCalledWith("off");
  },
};

// ─── Brightness interaction ───────────────────────────────────────────────────

export const BrightnessInteraction: Story = {
  name: "Interaction , slider fires onBrightness",
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement.ownerDocument.body);
    const slider = canvas.getByLabelText("Brightness") as HTMLInputElement;
    // React tracks the input's value internally; setting .value directly is
    // ignored on the next change event. Use the native setter so React's
    // onChange fires with the new value (standard controlled-input test idiom).
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    setter?.call(slider, "65");
    slider.dispatchEvent(new Event("change", { bubbles: true }));
    // onBrightness is debounced 400ms (trailing edge) , wait for it to fire.
    await waitFor(() => expect(args.onBrightness).toHaveBeenCalledWith(65));
  },
};
