import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { useEffect } from "react";
import { NotificationBridge } from "./components/NotificationBridge";
import { PanelFrame } from "./components/PanelFrame";
import { PushRegistrar } from "./components/PushRegistrar";
import { queryClient, trpc, trpcClient } from "./lib/trpc";
import { useAccentTheme } from "./lib/useAccentTheme";
import { useDeviceSettingsSync } from "./lib/useDeviceSettingsSync";
import { useSettingsSync } from "./lib/useSettingsSync";
import { useTypefaceTheme } from "./lib/useTypefaceTheme";
import { useVolumeSync } from "./lib/useVolumeSync";
import { startVersionCheck } from "./lib/version-check";
import { routeTree } from "./routeTree.gen";

const router = createRouter({ routeTree });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

// Runs the global-settings sync loop. Rendered inside the tRPC + Query providers
// (it uses tRPC hooks) and returns nothing , it only wires store ↔ server.
function SettingsSync() {
  useSettingsSync();
  return null;
}

// Same job for the per-device settings row (volume). A SEPARATE component, not
// another hook call inside SettingsSync: each owns a tRPC query, and keeping
// them apart means one poll settling cannot re-render the other's subscribers.
function DeviceSettingsSync() {
  useDeviceSettingsSync();
  return null;
}

// Applies the stored volume to the device and adopts hardware button presses
// back. Separate from DeviceSettingsSync because it touches no tRPC at all ,
// it is purely store ↔ hardware, and is a no-op off the panel.
function VolumeSync() {
  useVolumeSync();
  return null;
}

// Paints the chosen accent onto :root. Its own component for the same reason as
// VolumeSync , it subscribes to the settings store and renders nothing, so
// keeping it out of App means an accent change re-renders only this null node.
function AccentTheme() {
  useAccentTheme();
  return null;
}

// Paints the chosen typeface onto :root, same story as AccentTheme.
function TypefaceTheme() {
  useTypefaceTheme();
  return null;
}

export function App() {
  // Kiosk auto-refresh (www-ss8s): poll the deployed build stamp and hard-reload
  // once when an OTA deploy ships a new SHA. No-op in local dev (hash "dev").
  useEffect(() => startVersionCheck(), []);

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <SettingsSync />
        <AccentTheme />
        <TypefaceTheme />
        <DeviceSettingsSync />
        <VolumeSync />
        {/* Persists the board's ephemeral banner alerts into the Notification
            Center. Lives here, not in Board, because it needs the tRPC provider
            and renders nothing , and because keeping it out of Board keeps the
            banners (and Board's provider-free tests) untouched. */}
        <NotificationBridge />
        {/* Re-registers with APNs on every launch when push is enabled. At
            app level, not in Settings: a normal launch never opens Settings,
            which is precisely why a stuck device never recovered. */}
        <PushRegistrar />
        {/* Caps the web app to the 1366x1024 panel resolution and, on a
            desktop browser with room to spare, frames it like a device.
            Passthrough (no-op) on the native kiosk shell , see PanelFrame.tsx. */}
        <PanelFrame>
          <RouterProvider router={router} />
        </PanelFrame>
      </QueryClientProvider>
    </trpc.Provider>
  );
}
