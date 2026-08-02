/**
 * Tests for TvNowPlayingTile and TvNowPlayingTileView (www-51hf.15).
 *
 * A19: artwork, app_name + source line, clamped title, prev/play-pause/next
 *      transport, scrub bar with mono position/duration, source-aware states.
 * A17: built from shared ui primitives, not re-inlined.
 * A18: resolves via tRPC, renders Skeleton while pending/error , no fake data.
 * A31: TvNowPlayingTile registered in TILE_REGISTRY (www-51hf.50).
 */
import "@testing-library/jest-dom";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import tvManifest from "../../manifest";
import { TvNowPlayingTile } from "../TvNowPlayingTile";
import { TvNowPlayingTileView } from "../TvNowPlayingTileView";

afterEach(cleanup);

// ── Mock tRPC hook ────────────────────────────────────────────────────────────
vi.mock("@/lib/trpc", () => {
  const useQuery = vi.fn();
  const useMutation = vi.fn(() => ({ mutate: vi.fn() }));
  return {
    trpc: {
      tv: {
        tvNowPlaying: { useQuery },
        tvPlay: { useMutation },
        tvPause: { useMutation },
        tvNext: { useMutation },
        tvPrevious: { useMutation },
        tvSeek: { useMutation },
        tvRemote: { useMutation },
      },
    },
    queryClient: {},
    trpcClient: {},
  };
});

async function getTvUseQuery() {
  const mod = await import("@/lib/trpc");
  return mod.trpc.tv.tvNowPlaying.useQuery as ReturnType<typeof vi.fn>;
}

// ── TvNowPlayingTileView unit tests ───────────────────────────────────────────

describe("TvNowPlayingTileView , skeleton (loading / error)", () => {
  it("renders a .tile container in loading state", () => {
    const { container } = render(<TvNowPlayingTileView status="loading" />);
    expect(container.querySelector(".tile")).toBeInTheDocument();
  });

  it("renders a .tile container in error state", () => {
    const { container } = render(<TvNowPlayingTileView status="error" />);
    expect(container.querySelector(".tile")).toBeInTheDocument();
  });

  it("does NOT render real content while loading (no fake data)", () => {
    render(<TvNowPlayingTileView status="loading" />);
    expect(screen.queryByText(/Netflix/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/\d:\d\d/)).not.toBeInTheDocument();
  });

  it("renders at least one skeleton shimmer while loading (A18)", () => {
    const { container } = render(<TvNowPlayingTileView status="loading" />);
    expect(container.querySelectorAll("[data-skeleton]").length).toBeGreaterThan(0);
  });
});

describe("TvNowPlayingTileView , streaming playing state (A19)", () => {
  const streamingPlaying = {
    status: "populated" as const,
    state: "playing",
    appName: "Netflix",
    mediaTitle: "Stranger Things",
    mediaArtist: "Netflix Originals",
    mediaPosition: 125,
    mediaDuration: 3600,
    source: "streaming" as const,
    artworkUrl: null,
  };

  it("renders the tile header title 'TV'", () => {
    render(<TvNowPlayingTileView {...streamingPlaying} />);
    expect(screen.getByText("TV")).toBeInTheDocument();
  });

  it("renders app_name source line (A19)", () => {
    render(<TvNowPlayingTileView {...streamingPlaying} />);
    // Netflix appears in both the pill (source label) and the artist source line
    expect(screen.getAllByText(/Netflix/).length).toBeGreaterThan(0);
  });

  it("renders media title (A19)", () => {
    render(<TvNowPlayingTileView {...streamingPlaying} />);
    expect(screen.getByText("Stranger Things")).toBeInTheDocument();
  });

  it("renders transport controls: prev, play-pause, next (A19)", () => {
    render(<TvNowPlayingTileView {...streamingPlaying} />);
    expect(screen.getByLabelText(/previous/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/play|pause/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/next/i)).toBeInTheDocument();
  });

  it("renders scrub bar (A19)", () => {
    const { container } = render(<TvNowPlayingTileView {...streamingPlaying} />);
    // Scrub bar is an <input type="range"> or a div with data-scrub
    const scrub =
      container.querySelector("[data-scrub]") ?? container.querySelector("input[type='range']");
    expect(scrub).toBeInTheDocument();
  });

  it("renders mono position/duration text (A19)", () => {
    render(<TvNowPlayingTileView {...streamingPlaying} />);
    // 125s = 2:05, 3600s = 1:00:00
    expect(screen.getByText("2:05")).toBeInTheDocument();
  });
});

describe("TvNowPlayingTileView , streaming paused state", () => {
  it("shows paused state correctly", () => {
    render(
      <TvNowPlayingTileView
        status="populated"
        state="paused"
        appName="Disney+"
        mediaTitle="The Mandalorian"
        mediaArtist={null}
        mediaPosition={60}
        mediaDuration={2700}
        source="streaming"
        artworkUrl={null}
      />,
    );
    // Disney+ appears in pill AND artist line (appName fallback when no mediaArtist)
    expect(screen.getAllByText("Disney+").length).toBeGreaterThan(0);
    expect(screen.getByText("The Mandalorian")).toBeInTheDocument();
    expect(screen.getByLabelText(/play|pause/i)).toBeInTheDocument();
  });
});

// ── Transport callback tests (A19, www-51hf.52) ────────────────────────────────

describe("TvNowPlayingTileView , transport callbacks (A19)", () => {
  const streamingProps = {
    status: "populated" as const,
    state: "playing",
    appName: "Netflix",
    mediaTitle: "Stranger Things",
    mediaArtist: "Netflix Originals",
    mediaPosition: 125,
    mediaDuration: 3600,
    source: "streaming" as const,
    artworkUrl: null,
  };

  it("calls onPrev when previous button is clicked", () => {
    const onPrev = vi.fn();
    render(<TvNowPlayingTileView {...streamingProps} onPrev={onPrev} />);
    fireEvent.click(screen.getByLabelText(/previous/i));
    expect(onPrev).toHaveBeenCalledTimes(1);
  });

  it("calls onPlayPause when play-pause button is clicked (playing -> paused)", () => {
    const onPlayPause = vi.fn();
    render(<TvNowPlayingTileView {...streamingProps} state="playing" onPlayPause={onPlayPause} />);
    fireEvent.click(screen.getByLabelText("Pause"));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });

  it("calls onPlayPause when play-pause button is clicked (paused -> playing)", () => {
    const onPlayPause = vi.fn();
    render(<TvNowPlayingTileView {...streamingProps} state="paused" onPlayPause={onPlayPause} />);
    fireEvent.click(screen.getByLabelText("Play"));
    expect(onPlayPause).toHaveBeenCalledTimes(1);
  });

  it("calls onNext when next button is clicked", () => {
    const onNext = vi.fn();
    render(<TvNowPlayingTileView {...streamingProps} onNext={onNext} />);
    fireEvent.click(screen.getByLabelText(/next/i));
    expect(onNext).toHaveBeenCalledTimes(1);
  });

  it("calls onSeek on release with the dragged position (A19)", () => {
    const onSeek = vi.fn();
    render(<TvNowPlayingTileView {...streamingProps} onSeek={onSeek} />);
    const scrub = screen.getByRole("slider", { name: "Seek" });

    // Drag to 1800s then release , seek fires once on release.
    fireEvent.change(scrub, { target: { value: "1800" } });
    expect(onSeek).not.toHaveBeenCalled();
    fireEvent.pointerUp(scrub);
    expect(onSeek).toHaveBeenCalledTimes(1);
    expect(onSeek).toHaveBeenCalledWith(1800);
  });
});

describe("TvNowPlayingTileView , line-in source", () => {
  it("shows line-in label when source is line-in", () => {
    render(
      <TvNowPlayingTileView
        status="populated"
        state="playing"
        appName={null}
        mediaTitle={null}
        mediaArtist={null}
        mediaPosition={null}
        mediaDuration={null}
        source="line-in"
        artworkUrl={null}
      />,
    );
    expect(screen.getByText(/line.in/i)).toBeInTheDocument();
  });
});

describe("TvNowPlayingTileView , TV source", () => {
  it("shows TV source label when source is TV", () => {
    render(
      <TvNowPlayingTileView
        status="populated"
        state="playing"
        appName="TV"
        mediaTitle="Live Sports"
        mediaArtist={null}
        mediaPosition={null}
        mediaDuration={null}
        source="TV"
        artworkUrl={null}
      />,
    );
    // The pill shows "Live TV" for TV source; header also shows "TV" , check pill specifically
    expect(screen.getByText("Live TV")).toBeInTheDocument();
  });
});

describe("TvNowPlayingTileView , idle source", () => {
  it("shows idle / standby state when source is idle", () => {
    render(
      <TvNowPlayingTileView
        status="populated"
        state="idle"
        appName={null}
        mediaTitle={null}
        mediaArtist={null}
        mediaPosition={null}
        mediaDuration={null}
        source="idle"
        artworkUrl={null}
      />,
    );
    // idle state renders something , at least a .tile with header
    expect(screen.getByText("TV")).toBeInTheDocument();
  });
});

// ── Artwork, layout, scrubber visibility (www-dhhr) ────────────────────────────

describe("TvNowPlayingTileView , artwork rendering (www-dhhr)", () => {
  const withArtwork = {
    status: "populated" as const,
    state: "playing",
    appName: "YouTube",
    mediaTitle: "WWDC 2026 Impressions",
    mediaArtist: "Marques Brownlee",
    mediaPosition: 2,
    mediaDuration: 987,
    source: "streaming" as const,
    artworkUrl: "/media/tv-artwork?v=abc123",
  };

  it("renders the artwork image with the given src", () => {
    const { container } = render(<TvNowPlayingTileView {...withArtwork} />);
    const img = container.querySelector("img[data-artwork]");
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute("src", "/media/tv-artwork?v=abc123");
  });

  it("artwork is the flexible element so it absorbs height slack", () => {
    const { container } = render(<TvNowPlayingTileView {...withArtwork} />);
    const img = container.querySelector("img[data-artwork]") as HTMLElement;
    expect(img.style.flexGrow).toBe("1");
    expect(img.style.minHeight).toBe("0px");
  });

  it("artwork placeholder is also flexible when no artworkUrl", () => {
    const { container } = render(<TvNowPlayingTileView {...withArtwork} artworkUrl={null} />);
    const ph = container.querySelector("[data-artwork]") as HTMLElement;
    expect(ph).toBeInTheDocument();
    expect(ph.style.flexGrow).toBe("1");
  });
});

describe("TvNowPlayingTileView , text block never squeezed (www-dhhr)", () => {
  const props = {
    status: "populated" as const,
    state: "playing",
    appName: "YouTube",
    mediaTitle: "WWDC 2026 Impressions",
    mediaArtist: "Marques Brownlee",
    mediaPosition: 2,
    mediaDuration: 987,
    source: "streaming" as const,
    artworkUrl: null,
  };

  it("title/artist block has flex-shrink 0 so the artist line cannot be clipped", () => {
    const { container } = render(<TvNowPlayingTileView {...props} />);
    const text = container.querySelector("[data-media-text]") as HTMLElement;
    expect(text).toBeInTheDocument();
    expect(text.style.flexShrink).toBe("0");
    expect(text.style.flexGrow).not.toBe("1");
    expect(screen.getByText("Marques Brownlee")).toBeInTheDocument();
  });
});

describe("TvNowPlayingTileView , scrubber visibility (www-dhhr)", () => {
  const props = {
    status: "populated" as const,
    state: "playing",
    appName: "YouTube",
    mediaTitle: "WWDC 2026 Impressions",
    mediaArtist: "Marques Brownlee",
    mediaPosition: 2,
    mediaDuration: 987,
    source: "streaming" as const,
    artworkUrl: null,
  };

  it("renders the shared Slider scrub variant with the standard rail", () => {
    const { container } = render(<TvNowPlayingTileView {...props} />);
    const scrub = container.querySelector("input.range.range-scrub") as HTMLInputElement;
    expect(scrub).toBeInTheDocument();
    // --p drives the shared fill gradient; must reflect the playback fraction.
    expect(scrub.style.getPropertyValue("--p")).toContain("%");
  });

  it("reflects the playback position in the slider value", () => {
    const { container } = render(<TvNowPlayingTileView {...props} />);
    const scrub = container.querySelector("input.range-scrub") as HTMLInputElement;
    expect(scrub.value).toBe("2");
    expect(scrub.max).toBe("987");
  });
});

// ── Live position ticking (www-dhhr) ───────────────────────────────────────────

describe("TvNowPlayingTile , live position while playing (www-dhhr)", () => {
  function mockNowPlaying(overrides: Record<string, unknown>) {
    return {
      state: "playing",
      appName: "YouTube",
      mediaTitle: "WWDC 2026 Impressions",
      mediaArtist: "Marques Brownlee",
      mediaPosition: 2,
      mediaDuration: 987,
      source: "streaming",
      artworkUrl: null,
      mediaPositionUpdatedAt: null,
      ...overrides,
    };
  }

  afterEach(() => {
    vi.useRealTimers();
  });

  it("advances the displayed position each second while playing", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T20:00:00Z"));
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({
      data: mockNowPlaying({ mediaPositionUpdatedAt: "2026-06-09T20:00:00Z" }),
      isLoading: false,
      isError: false,
    });

    render(<TvNowPlayingTile />);
    expect(screen.getByText("0:02")).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("0:12")).toBeInTheDocument();
  });

  it("accounts for time already elapsed since media_position_updated_at", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T20:00:30Z"));
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({
      data: mockNowPlaying({ mediaPositionUpdatedAt: "2026-06-09T20:00:00Z" }),
      isLoading: false,
      isError: false,
    });

    render(<TvNowPlayingTile />);
    // position 2 sampled 30s ago → shows 0:32 immediately
    expect(screen.getByText("0:32")).toBeInTheDocument();
  });

  it("does not advance while paused", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T20:00:00Z"));
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({
      data: mockNowPlaying({
        state: "paused",
        mediaPositionUpdatedAt: "2026-06-09T20:00:00Z",
      }),
      isLoading: false,
      isError: false,
    });

    render(<TvNowPlayingTile />);
    act(() => {
      vi.advanceTimersByTime(10_000);
    });
    expect(screen.getByText("0:02")).toBeInTheDocument();
    expect(screen.queryByText("0:12")).not.toBeInTheDocument();
  });

  it("clamps the live position to the duration", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T20:00:00Z"));
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({
      data: mockNowPlaying({
        mediaPosition: 985,
        mediaPositionUpdatedAt: "2026-06-09T20:00:00Z",
      }),
      isLoading: false,
      isError: false,
    });

    render(<TvNowPlayingTile />);
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    // 985 + 60 would be 17:25 > duration 16:27 , must clamp to 16:27
    expect(screen.getAllByText("16:27").length).toBeGreaterThan(0);
  });
});

describe("TvNowPlayingTile , artwork pass-through (www-dhhr)", () => {
  it("passes the query artworkUrl to the view (no hardcoded null)", async () => {
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({
      data: {
        state: "playing",
        appName: "YouTube",
        mediaTitle: "My Video",
        mediaArtist: "Creator",
        mediaPosition: 30,
        mediaDuration: 300,
        source: "streaming",
        artworkUrl: "/media/tv-artwork?v=zzz",
        mediaPositionUpdatedAt: null,
      },
      isLoading: false,
      isError: false,
    });
    const { container } = render(<TvNowPlayingTile />);
    const img = container.querySelector("img[data-artwork]");
    expect(img).toHaveAttribute("src", "/media/tv-artwork?v=zzz");
  });
});

// ── Transport button sizing (www-d564) ─────────────────────────────────────────
// Wall-panel tap targets: 2x the original 32/42px buttons and 18/22px icons.

describe("TvNowPlayingTileView , 2x transport buttons (www-d564)", () => {
  const props = {
    status: "populated" as const,
    state: "playing",
    appName: "YouTube",
    mediaTitle: "WWDC 2026 Impressions",
    mediaArtist: "Marques Brownlee",
    mediaPosition: 2,
    mediaDuration: 987,
    source: "streaming" as const,
    artworkUrl: null,
  };

  it("prev/next buttons are 64px with 36px icons", () => {
    render(<TvNowPlayingTileView {...props} />);
    for (const label of [/previous/i, /next/i]) {
      const btn = screen.getByLabelText(label) as HTMLElement;
      expect(btn.style.width).toBe("64px");
      expect(btn.style.height).toBe("64px");
      const svg = btn.querySelector("svg") as SVGElement;
      expect(svg.getAttribute("width")).toBe("36");
      expect(svg.getAttribute("height")).toBe("36");
    }
  });

  it("play-pause button is 84px with a 44px icon", () => {
    render(<TvNowPlayingTileView {...props} />);
    const btn = screen.getByLabelText("Pause") as HTMLElement;
    expect(btn.style.width).toBe("84px");
    expect(btn.style.height).toBe("84px");
    const svg = btn.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("width")).toBe("44");
    expect(svg.getAttribute("height")).toBe("44");
  });
});

// ── App manifest tests (A31, www-51hf.50) ─────────────────────────────────────

describe("TV App manifest , TvNowPlayingTile registration (A31)", () => {
  it("declares TvNowPlayingTile", () => {
    const entry = tvManifest.tiles.find((tile) => tile.component === TvNowPlayingTile);
    expect(entry, "TvNowPlayingTile must be declared by the TV App").toBeDefined();
  });

  it("declares the required world Placement", () => {
    const entry = tvManifest.tiles.find((tile) => tile.component === TvNowPlayingTile);
    expect(entry?.worldCol, "worldCol must be a number").toBeTypeOf("number");
    expect(entry?.worldRow, "worldRow must be a number").toBeTypeOf("number");
    expect(entry?.cols).toBe(4);
    expect(entry?.rows).toBe(3);
  });
});

// ── Detail deep-link callbacks (A20, A21, www-51hf.53) ────────────────────────
// The full-page TV detail (Now Playing / Remote variants) is opened via the
// tile-detail store; TvNowPlayingTileView exposes onOpenTransport/onOpenRemote
// props that the tile binds to openTileDetail("tile_tv", ...).

describe("TvNowPlayingTileView , detail open callbacks (A20/A21)", () => {
  const streamingProps = {
    status: "populated" as const,
    state: "playing",
    appName: "Netflix",
    mediaTitle: "Stranger Things",
    mediaArtist: "Netflix Originals",
    mediaPosition: 125,
    mediaDuration: 3600,
    source: "streaming" as const,
    artworkUrl: null,
  };

  it("calls onOpenTransport when the transport-open control is activated (A20)", () => {
    const onOpenTransport = vi.fn();
    render(<TvNowPlayingTileView {...streamingProps} onOpenTransport={onOpenTransport} />);
    // A control with data-open-transport or aria-label matching "transport|detail|expand"
    const btn =
      document.querySelector("[data-open-transport]") ??
      screen.queryByLabelText(/transport|detail|expand/i);
    expect(btn, "onOpenTransport trigger must exist in TvNowPlayingTileView").not.toBeNull();
    fireEvent.click(btn as Element);
    expect(onOpenTransport).toHaveBeenCalledTimes(1);
  });

  it("calls onOpenRemote when the remote-open control is activated (A21)", () => {
    const onOpenRemote = vi.fn();
    render(<TvNowPlayingTileView {...streamingProps} onOpenRemote={onOpenRemote} />);
    const btn = document.querySelector("[data-open-remote]") ?? screen.queryByLabelText(/remote/i);
    expect(btn, "onOpenRemote trigger must exist in TvNowPlayingTileView").not.toBeNull();
    fireEvent.click(btn as Element);
    expect(onOpenRemote).toHaveBeenCalledTimes(1);
  });
});

// ── TvNowPlayingTile container tests ─────────────────────────────────────────

describe("TvNowPlayingTile , container (A18)", () => {
  it("renders skeleton while loading (no fake data)", async () => {
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({ data: undefined, isLoading: true, isError: false });
    const { container } = render(<TvNowPlayingTile />);
    expect(container.querySelector(".tile")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-skeleton]").length).toBeGreaterThan(0);
  });

  it("renders skeleton on error (no fake data)", async () => {
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    const { container } = render(<TvNowPlayingTile />);
    expect(container.querySelector(".tile")).toBeInTheDocument();
    expect(container.querySelectorAll("[data-skeleton]").length).toBeGreaterThan(0);
  });

  it("renders media data when query succeeds (A19)", async () => {
    const useQuery = await getTvUseQuery();
    useQuery.mockReturnValue({
      data: {
        state: "playing",
        appName: "YouTube",
        mediaTitle: "My Video",
        mediaArtist: "Creator",
        mediaPosition: 30,
        mediaDuration: 300,
        source: "streaming",
      },
      isLoading: false,
      isError: false,
    });
    render(<TvNowPlayingTile />);
    expect(screen.getByText("YouTube")).toBeInTheDocument();
    expect(screen.getByText("My Video")).toBeInTheDocument();
  });
});
