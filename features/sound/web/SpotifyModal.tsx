/**
 * SpotifyModal , the Quick Play detail page's "Spotify" variant
 * (www-51hf.25 / A30).
 *
 * Renders real Spotify content from the spotify.browse query:
 * - Recently played tracks in a horizontal row
 * - Made for you playlists in a horizontal row
 * - Target zone chip row (which Sonos room to play to)
 *
 * No stub/sample content , all data comes from real API calls via props.
 * Bare page body (no <Modal>) , hosted by TileDetailHost, which supplies the
 * page shell and header; live data comes from detail/wiring/quickplay.tsx.
 */

import { useState } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SpotifyTrack {
  /** Track display name. */
  trackName: string;
  artistName: string;
  albumArtUrl: string | null;
  trackUri: string;
}

export interface SpotifyPlaylist {
  name: string;
  uri: string;
  albumArtUrl: string | null;
}

/** Shape returned by the spotify.browse tRPC query for a recently-played item. */
export interface SpotifyBrowseTrack {
  id: string;
  title: string;
  artist: string;
  albumArtUrl: string | null;
  uri: string;
}

/** Shape returned by the spotify.browse tRPC query for a playlist. */
export interface SpotifyBrowsePlaylist {
  id: string;
  title: string;
  description: string | null;
  imageUrl: string | null;
  uri: string;
}

export interface SpotifyModalProps {
  /** Recently-played tracks from spotify.browse. */
  recentlyPlayed: SpotifyBrowseTrack[];
  /** Made-for-you playlists from spotify.browse. */
  playlists: SpotifyBrowsePlaylist[];
  zones: Array<{ name: string; entityId: string }> | string[];
  onPlay: (uri: string, entityId: string) => void;
}

// ── Cover item ────────────────────────────────────────────────────────────────

interface CoverItemProps {
  title: string;
  subtitle?: string;
  artUrl: string | null;
  onClick: () => void;
}

function CoverItem({ title, subtitle, artUrl, onClick }: CoverItemProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flexShrink: 0,
        width: 80,
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-start",
        gap: 4,
        background: "none",
        border: "none",
        cursor: "pointer",
        padding: 0,
        textAlign: "left",
      }}
    >
      <div
        style={{
          width: 72,
          height: 72,
          borderRadius: 8,
          background: artUrl ? "transparent" : "var(--tile-2)",
          overflow: "hidden",
          flexShrink: 0,
        }}
      >
        {artUrl ? (
          <img
            src={artUrl}
            alt={title}
            style={{ width: "100%", height: "100%", objectFit: "cover" }}
          />
        ) : (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "var(--tile-2)",
            }}
          >
            <span style={{ fontSize: 22, fontWeight: 700, color: "var(--ink-3)" }}>{title[0]}</span>
          </div>
        )}
      </div>
      <span
        style={{
          fontSize: 11,
          fontWeight: 600,
          color: "var(--ink-1)",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          maxWidth: 72,
        }}
      >
        {title}
      </span>
      {subtitle && (
        <span
          style={{
            fontSize: 10,
            color: "var(--ink-3)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 72,
          }}
        >
          {subtitle}
        </span>
      )}
    </button>
  );
}

// ── Horizontal row ────────────────────────────────────────────────────────────

function HorizontalRow({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "flex",
        gap: 12,
        overflowX: "auto",
        paddingBottom: 4,
        scrollbarWidth: "none",
      }}
    >
      {children}
    </div>
  );
}

// ── Main view ─────────────────────────────────────────────────────────────────

export function SpotifyModal({ recentlyPlayed, playlists, zones, onPlay }: SpotifyModalProps) {
  const normalizedZones = zones.map((zone) =>
    typeof zone === "string" ? { name: zone, entityId: zone } : zone,
  );
  const [selectedZone, setSelectedZone] = useState<string>(normalizedZones[0]?.entityId ?? "");

  return (
    <div style={{ maxWidth: 920, margin: "0 auto" }}>
      <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
        {/* Zone picker chips */}
        <div>
          <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 6 }}>PLAY TO</div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {normalizedZones.map((zone) => (
              <button
                key={zone.entityId}
                type="button"
                onClick={() => setSelectedZone(zone.entityId)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 20,
                  border: "1px solid var(--tile-3)",
                  background: zone.entityId === selectedZone ? "var(--accent)" : "transparent",
                  color: zone.entityId === selectedZone ? "#fff" : "var(--ink-2)",
                  fontSize: 12,
                  cursor: "pointer",
                  fontWeight: zone.entityId === selectedZone ? 600 : 500,
                }}
              >
                {zone.name}
              </button>
            ))}
          </div>
        </div>

        {/* Recently played */}
        {recentlyPlayed.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ink-2)",
                marginBottom: 10,
              }}
            >
              Recently played
            </div>
            <HorizontalRow>
              {recentlyPlayed.map((track) => (
                <CoverItem
                  key={track.id}
                  title={track.title}
                  subtitle={track.artist}
                  artUrl={track.albumArtUrl}
                  onClick={() => onPlay(track.uri, selectedZone)}
                />
              ))}
            </HorizontalRow>
          </div>
        )}

        {/* Made for you / playlists */}
        {playlists.length > 0 && (
          <div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 600,
                color: "var(--ink-2)",
                marginBottom: 10,
              }}
            >
              Made for you
            </div>
            <HorizontalRow>
              {playlists.map((pl) => (
                <CoverItem
                  key={pl.id}
                  title={pl.title}
                  artUrl={pl.imageUrl}
                  onClick={() => onPlay(pl.uri, selectedZone)}
                />
              ))}
            </HorizontalRow>
          </div>
        )}

        {recentlyPlayed.length === 0 && playlists.length === 0 && (
          <div
            style={{
              textAlign: "center",
              color: "var(--ink-3)",
              fontSize: 13,
              padding: "20px 0",
            }}
          >
            No content available
          </div>
        )}
      </div>
    </div>
  );
}
