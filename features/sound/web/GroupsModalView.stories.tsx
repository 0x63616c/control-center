/**
 * Stories for GroupsModalView (www-51hf).
 * Patch-bay: sources on the left, real speaker/room list on the right. The
 * component is a bare page body now (hosted by TileDetailHost in the app), so
 * stories mount it inside a plain page-sized container matching the host's
 * content region.
 *
 * Fixture uuids/track lines are real, live-verified 2026-07-11 values (see
 * DESK_LINE_IN_UUID / BEAM_UUID in lib/sonos-constants.ts for the two hardware
 * anchors) , no invented tracks.
 */
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, fn } from "storybook/test";
import { modalDocsParameters, pageHostDecorator } from "@/components/tiles/__stories__/factory";
import { GroupsModalView } from "./GroupsModalView";
import { BEAM_UUID, DESK_LINE_IN_UUID } from "./lib/sonos-constants";

const BEDROOM_UUID = "RINCON_804AF28CFD6801400";
const KITCHEN_UUID = "RINCON_74CA60AA5F4C01400";
const BATHROOM_UUID = "RINCON_F85C2420570401400";

const speakers = [
  { uuid: BEAM_UUID, name: "Living Room" },
  { uuid: DESK_LINE_IN_UUID, name: "Desk" },
  { uuid: BEDROOM_UUID, name: "Bedroom" },
  { uuid: BATHROOM_UUID, name: "Bathroom" },
  { uuid: KITCHEN_UUID, name: "Kitchen" },
];

const deskSource = {
  id: "src_desk_linein",
  anchorUuid: DESK_LINE_IN_UUID,
  anchorIp: "10.0.1.21",
  roomName: "Desk",
  label: "Desk · Line-In",
  kind: "line-in" as const,
  isSession: false,
  colorVar: "--acc",
};

const tvSource = {
  id: "src_tv",
  anchorUuid: BEAM_UUID,
  anchorIp: "10.0.1.22",
  roomName: "Living Room",
  label: "Living Room · TV",
  kind: "tv" as const,
  isSession: false,
  colorVar: "--amber",
};

const bedroomSessionSource = {
  id: `src_session_${BEDROOM_UUID}`,
  anchorUuid: BEDROOM_UUID,
  anchorIp: "10.0.1.23",
  roomName: "Bedroom",
  label: "Bedroom · Spotify",
  kind: "spotify" as const,
  isSession: true,
  colorVar: "--teal",
};

const meta = {
  title: "Media/GroupsModalView",
  component: GroupsModalView,
  tags: ["autodocs"],
  parameters: { ...modalDocsParameters(), boardWrapper: false, layout: "fullscreen" },
  // Page-sized container standing in for the TileDetailHost content region.
  decorators: [pageHostDecorator()],
  args: {
    speakers,
    onSelectSource: fn(),
    onTapSpeaker: fn(),
  },
} satisfies Meta<typeof GroupsModalView>;

export default meta;
type Story = StoryObj<typeof meta>;

// Two stopped hardware cards, nothing joined to anything.
export const FloorSilent: Story = {
  args: {
    sources: [
      { ...deskSource, playing: false, selectable: true, trackLine: null },
      // Apple TV off , TV card not playing, so it is not selectable (www-tvoff).
      { ...tvSource, playing: false, selectable: false, trackLine: null },
    ],
    member: {
      [BEAM_UUID]: null,
      [DESK_LINE_IN_UUID]: null,
      [BEDROOM_UUID]: null,
      [BATHROOM_UUID]: null,
      [KITCHEN_UUID]: null,
    },
    selectedSourceId: "src_desk_linein",
  },
  play: async ({ canvasElement }) => {
    // The TV source (Apple TV off) is rendered disabled and reads "Off".
    const tvBtn = canvasElement.querySelector<HTMLButtonElement>(
      "[aria-label='Select Living Room · TV']",
    );
    await expect(tvBtn).toBeTruthy();
    await expect(tvBtn?.disabled).toBe(true);
    await expect(canvasElement.textContent).toContain("Off");
  },
};

// Desk line-in and Living Room TV both live, each anchored to its own room.
export const TwoLive: Story = {
  args: {
    sources: [
      { ...deskSource, playing: true, selectable: true, trackLine: null },
      { ...tvSource, playing: true, selectable: true, trackLine: null },
    ],
    member: {
      [BEAM_UUID]: "src_tv",
      [DESK_LINE_IN_UUID]: "src_desk_linein",
      [BEDROOM_UUID]: null,
      [BATHROOM_UUID]: null,
      [KITCHEN_UUID]: null,
    },
    selectedSourceId: "src_desk_linein",
  },
};

// Adds a live Bedroom Spotify session (SESSION badge, teal) on top of the two
// hardware sources; the session card is selected.
export const ThreeWithSession: Story = {
  args: {
    sources: [
      { ...deskSource, playing: true, selectable: true, trackLine: null },
      { ...tvSource, playing: true, selectable: true, trackLine: null },
      {
        ...bedroomSessionSource,
        playing: true,
        selectable: true,
        trackLine: "Twin Diplomacy — C'est La Vie",
      },
    ],
    member: {
      [BEAM_UUID]: "src_tv",
      [DESK_LINE_IN_UUID]: "src_desk_linein",
      [BEDROOM_UUID]: bedroomSessionSource.id,
      [BATHROOM_UUID]: null,
      [KITCHEN_UUID]: null,
    },
    selectedSourceId: bedroomSessionSource.id,
  },
};

// Kitchen + Bathroom patched to the Desk source; the (live) TV card is selected,
// so its own anchor row (Living Room) reads disabled.
export const MidPatch: Story = {
  args: {
    sources: [
      { ...deskSource, playing: true, selectable: true, trackLine: null },
      { ...tvSource, playing: true, selectable: true, trackLine: null },
    ],
    member: {
      [BEAM_UUID]: "src_tv",
      [DESK_LINE_IN_UUID]: "src_desk_linein",
      [BEDROOM_UUID]: null,
      [BATHROOM_UUID]: "src_desk_linein",
      [KITCHEN_UUID]: "src_desk_linein",
    },
    selectedSourceId: "src_tv",
  },
};
