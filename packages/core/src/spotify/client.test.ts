/**
 * Unit tests for SpotifyClient (www-51hf.33, www-51hf.36, www-51hf.37).
 * Validates token refresh, caching, throw-on-unconfigured, and A3
 * (no fabricated data when optional fields are absent from a real response).
 * All network calls are stubbed , tests never reach the Spotify API.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SpotifyClient, SpotifyError } from "./index";

const VALID_CREDS = {
  clientId: "test_client_id",
  clientSecret: "test_client_secret",
  refreshToken: "test_refresh_token",
};

function tokenResponse(expiresIn = 3600): Response {
  return new Response(
    JSON.stringify({
      access_token: "test_access_token",
      token_type: "Bearer",
      expires_in: expiresIn,
      scope: "user-read-playback-state user-modify-playback-state",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

describe("SpotifyClient , token refresh", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws SpotifyError when SPOTIFY_CLIENT_ID is empty", async () => {
    const client = new SpotifyClient({
      clientId: "",
      clientSecret: "secret",
      refreshToken: "refresh",
    });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SpotifyError);
  });

  it("throws SpotifyError when SPOTIFY_CLIENT_SECRET is empty", async () => {
    const client = new SpotifyClient({
      clientId: "id",
      clientSecret: "",
      refreshToken: "refresh",
    });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SpotifyError);
  });

  it("throws SpotifyError when SPOTIFY_REFRESH_TOKEN is empty", async () => {
    const client = new SpotifyClient({
      clientId: "id",
      clientSecret: "secret",
      refreshToken: "",
    });
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SpotifyError);
  });

  it("fetches a new token on first call", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(tokenResponse()));
    const client = new SpotifyClient(VALID_CREDS);
    const token = await client.getAccessToken();
    expect(token).toBe("test_access_token");
    expect(vi.mocked(fetch)).toHaveBeenCalledOnce();
  });

  it("returns cached token without a second fetch call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(tokenResponse(3600));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SpotifyClient(VALID_CREDS);
    const t1 = await client.getAccessToken();
    const t2 = await client.getAccessToken();
    expect(t1).toBe(t2);
    // Only one network request , second call hits the cache.
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("re-fetches when the token is within 60s of expiry", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse(55)) // first token expires in 55s (< 60s threshold)
      .mockResolvedValueOnce(tokenResponse(3600)); // second fresh token
    vi.stubGlobal("fetch", fetchMock);
    const client = new SpotifyClient(VALID_CREDS);
    await client.getAccessToken(); // primes the near-expired cache
    const token2 = await client.getAccessToken(); // should re-fetch
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(token2).toBe("test_access_token");
  });

  it("throws SpotifyError when the refresh request returns 400", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
        ),
    );
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SpotifyError);
  });

  it("throws SpotifyError on network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.getAccessToken()).rejects.toBeInstanceOf(SpotifyError);
  });
});

describe("SpotifyError", () => {
  it("is an instance of Error", () => {
    const err = new SpotifyError("test error");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("SpotifyError");
    expect(err.message).toBe("test error");
  });
});

describe("SpotifyClient , scene playback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("parses available Connect devices", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            devices: [
              {
                id: "living",
                name: "Living Room",
                type: "Speaker",
                is_active: true,
                is_restricted: false,
              },
            ],
          }),
          { status: 200 },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);
    await expect(new SpotifyClient(VALID_CREDS).getDevices()).resolves.toEqual([
      {
        id: "living",
        name: "Living Room",
        type: "Speaker",
        isActive: true,
        isRestricted: false,
      },
    ]);
  });

  it("transfers, configures shuffle, and starts an explicit playlist", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValue(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SpotifyClient(VALID_CREDS);
    await client.transferPlayback("living");
    await client.setShuffle(true, "living");
    await client.playContext("spotify:playlist:abc", "living");
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(fetchMock.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ device_ids: ["living"], play: false }),
    );
    expect(String(fetchMock.mock.calls[2]?.[0])).toContain("state=true&device_id=living");
    expect(fetchMock.mock.calls[3]?.[1]?.body).toBe(
      JSON.stringify({ context_uri: "spotify:playlist:abc" }),
    );
  });

  it("does not treat Spotify 403 as a successful scene launch", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(tokenResponse())
        .mockResolvedValueOnce(new Response("denied", { status: 403 })),
    );
    await expect(new SpotifyClient(VALID_CREDS).transferPlayback("living")).rejects.toThrow(
      "HTTP 403",
    );
  });
});

// ---------------------------------------------------------------------------
// getNowPlaying , missing optional fields (A3: no fabricated data)
// www-51hf.36 / www-51hf.37
// ---------------------------------------------------------------------------

// Intercepts fetch: first call returns the token, second call returns the player response.
function mockFetchForPlayer(playerRes: Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn().mockResolvedValueOnce(tokenResponse()).mockResolvedValueOnce(playerRes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

// Builds a minimal valid Spotify /v1/me/player JSON response with a fully-populated item.
function fullPlayerBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    is_playing: true,
    progress_ms: 60_000,
    device: { name: "Living Room Speaker", id: "abc", type: "Speaker" },
    item: {
      name: "Test Track",
      duration_ms: 240_000,
      artists: [{ name: "Test Artist" }],
      album: {
        name: "Test Album",
        images: [{ url: "https://i.scdn.co/image/test" }],
      },
    },
    ...overrides,
  });
}

describe("SpotifyClient , getNowPlaying (A3: no fabricated data)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns full state when all fields are present", async () => {
    mockFetchForPlayer(new Response(fullPlayerBody(), { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    const result = await client.getNowPlaying();
    expect(result).not.toBeNull();
    expect(result?.trackTitle).toBe("Test Track");
    expect(result?.artist).toBe("Test Artist");
    expect(result?.album).toBe("Test Album");
    expect(result?.progressMs).toBe(60_000);
    expect(result?.durationMs).toBe(240_000);
    expect(result?.albumArtUrl).toBe("https://i.scdn.co/image/test");
  });

  it("returns null when item is null (nothing playing)", async () => {
    mockFetchForPlayer(new Response(fullPlayerBody({ item: null }), { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    const result = await client.getNowPlaying();
    expect(result).toBeNull();
  });

  it("returns null when 204 No Content (nothing playing)", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new SpotifyClient(VALID_CREDS);
    const result = await client.getNowPlaying();
    expect(result).toBeNull();
  });

  // A3: item.name missing , must throw, not return trackTitle: ""
  it("throws SpotifyError when item.name is missing", async () => {
    const body = JSON.stringify({
      is_playing: true,
      progress_ms: 60_000,
      item: {
        // name intentionally absent
        duration_ms: 240_000,
        artists: [{ name: "Test Artist" }],
        album: { name: "Test Album", images: [] },
      },
    });
    mockFetchForPlayer(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.getNowPlaying()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: item.duration_ms missing , must throw, not return durationMs: 0
  it("throws SpotifyError when item.duration_ms is missing", async () => {
    const body = JSON.stringify({
      is_playing: true,
      progress_ms: 60_000,
      item: {
        name: "Test Track",
        // duration_ms intentionally absent
        artists: [{ name: "Test Artist" }],
        album: { name: "Test Album", images: [] },
      },
    });
    mockFetchForPlayer(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.getNowPlaying()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: album.name missing , must throw, not return album: ""
  it("throws SpotifyError when album.name is missing", async () => {
    const body = JSON.stringify({
      is_playing: true,
      progress_ms: 60_000,
      item: {
        name: "Test Track",
        duration_ms: 240_000,
        artists: [{ name: "Test Artist" }],
        album: {
          // name intentionally absent
          images: [{ url: "https://i.scdn.co/image/test" }],
        },
      },
    });
    mockFetchForPlayer(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.getNowPlaying()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: data.progress_ms missing , must throw, not return progressMs: 0
  it("throws SpotifyError when data.progress_ms is missing", async () => {
    const body = JSON.stringify({
      is_playing: true,
      // progress_ms intentionally absent
      item: {
        name: "Test Track",
        duration_ms: 240_000,
        artists: [{ name: "Test Artist" }],
        album: { name: "Test Album", images: [] },
      },
    });
    mockFetchForPlayer(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.getNowPlaying()).rejects.toBeInstanceOf(SpotifyError);
  });

  // progress_ms=0 is a valid value (track at start position), not fabricated
  it("accepts progress_ms=0 as a legitimate value", async () => {
    mockFetchForPlayer(new Response(fullPlayerBody({ progress_ms: 0 }), { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    const result = await client.getNowPlaying();
    expect(result?.progressMs).toBe(0);
  });

  // Empty artists array is legitimate (e.g. podcast episodes) , join produces ""
  it("returns empty string for artist when artists array is empty", async () => {
    const body = JSON.stringify({
      is_playing: true,
      progress_ms: 60_000,
      item: {
        name: "Test Track",
        duration_ms: 240_000,
        artists: [],
        album: { name: "Test Album", images: [] },
      },
    });
    mockFetchForPlayer(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    const result = await client.getNowPlaying();
    // Empty string from an empty array is derived from real data, not fabricated
    expect(result?.artist).toBe("");
  });
});

// ---------------------------------------------------------------------------
// fetchRecentlyPlayed , missing required fields (A3: no fabricated data)
// www-51hf.38 / www-51hf.40
// ---------------------------------------------------------------------------

// Intercepts fetch: token → recently-played response → (optional) playlists response.
function mockFetchForBrowse(recentRes: Response, playlistRes?: Response): ReturnType<typeof vi.fn> {
  const playlistResponse =
    playlistRes ??
    new Response(JSON.stringify({ items: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(recentRes)
    .mockResolvedValueOnce(playlistResponse);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SpotifyClient , fetchRecentlyPlayed (A3: no fabricated data)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns tracks when all required fields are present", async () => {
    const body = JSON.stringify({
      items: [
        {
          track: {
            id: "t1",
            name: "Real Track",
            uri: "spotify:track:t1",
            artists: [{ name: "Artist" }],
            album: { images: [] },
          },
        },
      ],
    });
    mockFetchForBrowse(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    const result = await client.browse();
    expect(result.recentlyPlayed).toHaveLength(1);
    expect(result.recentlyPlayed[0].title).toBe("Real Track");
    expect(result.recentlyPlayed[0].uri).toBe("spotify:track:t1");
  });

  // A3: track.name missing , must throw, not return title: ""
  it("throws SpotifyError when track.name is missing in recently-played", async () => {
    const body = JSON.stringify({
      items: [
        {
          track: {
            id: "t1",
            // name intentionally absent
            uri: "spotify:track:t1",
            artists: [{ name: "Artist" }],
            album: { images: [] },
          },
        },
      ],
    });
    mockFetchForBrowse(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: track.name is empty string , must throw, not return title: ""
  it("throws SpotifyError when track.name is empty string in recently-played", async () => {
    const body = JSON.stringify({
      items: [
        {
          track: {
            id: "t1",
            name: "",
            uri: "spotify:track:t1",
            artists: [{ name: "Artist" }],
            album: { images: [] },
          },
        },
      ],
    });
    mockFetchForBrowse(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: track.uri missing , must throw, not return uri: ""
  it("throws SpotifyError when track.uri is missing in recently-played", async () => {
    const body = JSON.stringify({
      items: [
        {
          track: {
            id: "t1",
            name: "Real Track",
            // uri intentionally absent
            artists: [{ name: "Artist" }],
            album: { images: [] },
          },
        },
      ],
    });
    mockFetchForBrowse(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: track.uri is empty string , must throw, not return uri: ""
  it("throws SpotifyError when track.uri is empty string in recently-played", async () => {
    const body = JSON.stringify({
      items: [
        {
          track: {
            id: "t1",
            name: "Real Track",
            uri: "",
            artists: [{ name: "Artist" }],
            album: { images: [] },
          },
        },
      ],
    });
    mockFetchForBrowse(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });
});

// ---------------------------------------------------------------------------
// fetchPlaylists , missing required fields (A3: no fabricated data)
// www-51hf.39 / www-51hf.40
// ---------------------------------------------------------------------------

// Intercepts fetch: token → recently-played (empty) → playlists response.
function mockFetchForPlaylists(playlistRes: Response): ReturnType<typeof vi.fn> {
  const emptyRecentRes = new Response(JSON.stringify({ items: [] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(tokenResponse())
    .mockResolvedValueOnce(emptyRecentRes)
    .mockResolvedValueOnce(playlistRes);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("SpotifyClient , fetchPlaylists (A3: no fabricated data)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns playlists when all required fields are present", async () => {
    const body = JSON.stringify({
      items: [
        {
          id: "p1",
          name: "Real Playlist",
          uri: "spotify:playlist:p1",
          description: "A playlist",
          images: [{ url: "https://i.scdn.co/image/pl" }],
        },
      ],
    });
    mockFetchForPlaylists(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    const result = await client.browse();
    expect(result.playlists).toHaveLength(1);
    expect(result.playlists[0].title).toBe("Real Playlist");
    expect(result.playlists[0].uri).toBe("spotify:playlist:p1");
  });

  // A3: pl.name missing , must throw, not return title: ""
  it("throws SpotifyError when pl.name is missing in playlists", async () => {
    const body = JSON.stringify({
      items: [
        {
          id: "p1",
          // name intentionally absent
          uri: "spotify:playlist:p1",
          images: [],
        },
      ],
    });
    mockFetchForPlaylists(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: pl.name is empty string , must throw, not return title: ""
  it("throws SpotifyError when pl.name is empty string in playlists", async () => {
    const body = JSON.stringify({
      items: [
        {
          id: "p1",
          name: "",
          uri: "spotify:playlist:p1",
          images: [],
        },
      ],
    });
    mockFetchForPlaylists(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: pl.uri missing , must throw, not return uri: ""
  it("throws SpotifyError when pl.uri is missing in playlists", async () => {
    const body = JSON.stringify({
      items: [
        {
          id: "p1",
          name: "Real Playlist",
          // uri intentionally absent
          images: [],
        },
      ],
    });
    mockFetchForPlaylists(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });

  // A3: pl.uri is empty string , must throw, not return uri: ""
  it("throws SpotifyError when pl.uri is empty string in playlists", async () => {
    const body = JSON.stringify({
      items: [
        {
          id: "p1",
          name: "Real Playlist",
          uri: "",
          images: [],
        },
      ],
    });
    mockFetchForPlaylists(new Response(body, { status: 200 }));
    const client = new SpotifyClient(VALID_CREDS);
    await expect(client.browse()).rejects.toBeInstanceOf(SpotifyError);
  });
});
