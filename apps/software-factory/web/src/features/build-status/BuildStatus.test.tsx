import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { BuildStatus } from "@/features/build-status/BuildStatus";

describe("BuildStatus", () => {
  it("renders a loading state", () => {
    render(<BuildStatus state={{ kind: "loading" }} />);
    expect(screen.getByTestId("build-status")).toHaveTextContent("Loading build info");
  });

  it("renders the build version once ready", () => {
    render(<BuildStatus state={{ kind: "ready", version: "abc1234" }} />);
    expect(screen.getByTestId("build-status")).toHaveTextContent("abc1234");
  });

  it("renders an error without pretending the version is known", () => {
    render(<BuildStatus state={{ kind: "error", message: "Network Error" }} />);
    expect(screen.getByRole("alert")).toHaveTextContent("Network Error");
  });
});
