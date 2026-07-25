import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useDeviceName } from "../../lib/device-name";
import { DeviceNameBanner } from "../DeviceNameBanner";

// Isolate the store so the test drives the "is set" state directly.
vi.mock("../../lib/device-name");

const mockUseDeviceName = vi.mocked(useDeviceName);

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("DeviceNameBanner", () => {
  it("renders the red banner when the name is unset", () => {
    mockUseDeviceName.mockReturnValue({ name: "iPad", isSet: false });
    render(<DeviceNameBanner />);
    expect(screen.getByRole("alert")).not.toBeNull();
    expect(screen.getByText(/set your device name in settings/i)).not.toBeNull();
  });

  it("renders nothing once the name is set", () => {
    mockUseDeviceName.mockReturnValue({ name: "Calum's Laptop", isSet: true });
    const { container } = render(<DeviceNameBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("has no dismiss control (cannot be dismissed, only cleared by setting a name)", () => {
    mockUseDeviceName.mockReturnValue({ name: "iPad", isSet: false });
    render(<DeviceNameBanner />);
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("clears the banner when isSet transitions to true", () => {
    mockUseDeviceName.mockReturnValue({ name: "iPad", isSet: false });
    const { rerender } = render(<DeviceNameBanner />);
    expect(screen.getByRole("alert")).not.toBeNull();

    mockUseDeviceName.mockReturnValue({ name: "iPad", isSet: true });
    rerender(<DeviceNameBanner />);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
