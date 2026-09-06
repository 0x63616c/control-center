// Design question: can the requested daily controls fit a calm, non-scrolling
// 1366 × 1024 bento? One direction follows the user's explicit visual reference.
// Initial values are a read-only production snapshot from 2026-09-06 18:54 UTC.
// All subsequent interactions are local; this prototype has no device mutations.
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  BedDouble,
  Check,
  CloudRain,
  Fan,
  House,
  Lamp,
  Minus,
  Plug,
  Plus,
  Power,
  Snowflake,
  Sofa,
  Sun,
  Tv,
  Volume2,
  Wind,
} from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button } from "../ui/Button";
import "./bento-home.css";

const MODES = { off: "Off", cool: "Cool", heat: "Heat", heat_cool: "Auto" } as const;
type Mode = keyof typeof MODES;
const HOURS = [
  { label: "Now", temp: 67 },
  { label: "12 PM", temp: 70 },
  { label: "1 PM", temp: 74 },
  { label: "2 PM", temp: 75 },
  { label: "3 PM", temp: 76 },
  { label: "4 PM", temp: 77 },
  { label: "5 PM", temp: 77 },
  { label: "6 PM", temp: 77 },
  { label: "7 PM", temp: 75 },
  { label: "8 PM", temp: 73 },
  { label: "9 PM", temp: 72 },
  { label: "10 PM", temp: 72 },
];
function Tap({
  children,
  onClick,
  label,
  selected = false,
  className = "",
  disabled = false,
}: {
  children: ReactNode;
  onClick: () => void;
  label?: string;
  selected?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      className={`bh-tap ${className}`}
      aria-label={label}
      aria-pressed={selected}
      onClick={onClick}
      disabled={disabled}
      style={{
        width: undefined,
        height: undefined,
        display: undefined,
        alignItems: undefined,
        justifyContent: undefined,
        gap: undefined,
        padding: undefined,
        borderRadius: undefined,
        border: undefined,
        background: undefined,
        color: undefined,
        fontFamily: undefined,
        fontSize: undefined,
        fontWeight: undefined,
        letterSpacing: undefined,
      }}
    >
      {children}
    </Button>
  );
}
function Switch({ on, onClick, label }: { on: boolean; onClick: () => void; label: string }) {
  return (
    <Tap className={`bh-switch ${on ? "is-on" : ""}`} selected={on} onClick={onClick} label={label}>
      <span />
    </Tap>
  );
}
export function BentoHome() {
  const [now, setNow] = useState(new Date());
  const [bedroom, setBedroom] = useState(true);
  const [living, setLiving] = useState(true);
  const [fan, setFan] = useState(true);
  const [mode, setMode] = useState<Mode>("cool");
  const [target, setTarget] = useState(73);
  const [range, setRange] = useState({ low: 70, high: 75 });
  const [rangeSide, setRangeSide] = useState<"low" | "high">("low");
  const [volume, setVolume] = useState(90);
  const [source, setSource] = useState<"line-in" | "tv">("line-in");
  const [notice, setNotice] = useState("Read-only snapshot · Sep 6, 11:54 AM");
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);
  const preview = (message: string) => setNotice(`Preview · ${message}`);
  function step(delta: number) {
    if (mode === "off") return;
    if (mode === "heat_cool") {
      setRange((r) =>
        rangeSide === "low"
          ? { ...r, low: Math.max(50, Math.min(r.high - 1, r.low + delta)) }
          : { ...r, high: Math.min(90, Math.max(r.low + 1, r.high + delta)) },
      );
    } else setTarget((t) => Math.min(90, Math.max(50, t + delta)));
    preview("Temperature adjusted");
  }
  const clock = new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZone: "America/Los_Angeles",
  }).format(now);
  const date = new Intl.DateTimeFormat("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    timeZone: "America/Los_Angeles",
  }).format(now);
  return (
    <main className="bh-screen">
      <header className="bh-header">
        <div className="bh-brand">
          <House size={23} strokeWidth={1.6} />
          <span>Home</span>
        </div>
        <span className="bh-header-note">A little more at ease.</span>
        <span className="bh-edition">CONTROL PANEL</span>
      </header>
      <div className="bh-grid">
        <section className="bh-card bh-clock" aria-label="Time and date">
          <span className="bh-eyebrow">{date}</span>
          <div className="bh-time">
            {clock.replace(/\s[AP]M/, "")}
            <span>{clock.includes("AM") ? "AM" : "PM"}</span>
          </div>
          <div className="bh-clock-bottom">
            <span className="bh-dot" /> Your everyday, at a glance.
          </div>
        </section>
        <section className="bh-card bh-lamps">
          <div className="bh-card-head">
            <div className="bh-heading">
              <Lamp />
              <h2>Lamps</h2>
            </div>
            <div className="bh-master">
              <Tap
                selected={bedroom && living}
                onClick={() => {
                  setBedroom(true);
                  setLiving(true);
                  preview("All lamps on");
                }}
              >
                All on
              </Tap>
              <Tap
                selected={!bedroom && !living}
                onClick={() => {
                  setBedroom(false);
                  setLiving(false);
                  preview("All lamps off");
                }}
              >
                All off
              </Tap>
            </div>
          </div>
          <div className="bh-room-grid">
            <div className="bh-room">
              <BedDouble size={25} />
              <Switch
                on={bedroom}
                label="Bedroom lamps"
                onClick={() => {
                  setBedroom(!bedroom);
                  preview(`Bedroom lamps ${bedroom ? "off" : "on"}`);
                }}
              />
              <h3>Bedroom</h3>
              <p>Strip + two bedside lamps</p>
            </div>
            <div className="bh-room">
              <Sofa size={25} />
              <Switch
                on={living}
                label="Living room lamps"
                onClick={() => {
                  setLiving(!living);
                  preview(`Living room lamps ${living ? "off" : "on"}`);
                }}
              />
              <h3>Living room</h3>
              <p>The rest of the house lamps</p>
            </div>
          </div>
        </section>
        <section className={`bh-card bh-fan ${fan ? "bh-fan-on" : ""}`}>
          <div className="bh-card-head">
            <span className="bh-eyebrow">A little fresh air</span>
            <Switch
              on={fan}
              label="Fan"
              onClick={() => {
                setFan(!fan);
                preview(`Fan ${fan ? "off" : "on"}`);
              }}
            />
          </div>
          <Fan className="bh-fan-art" strokeWidth={1.2} />
          <div className="bh-fan-label">
            <h2>Fan</h2>
            <span>{fan ? "On" : "Off"}</span>
          </div>
        </section>
        <section className={`bh-card bh-climate bh-mode-${mode}`}>
          <div className="bh-card-head">
            <div className="bh-heading">
              <Snowflake />
              <h2>Air conditioning</h2>
            </div>
            <span className="bh-temp-unit">°F</span>
          </div>
          <div className="bh-climate-status">
            <span className="bh-dot" />
            {mode === "off"
              ? "System off"
              : mode === "cool"
                ? "Cool mode"
                : mode === "heat"
                  ? "Heat mode"
                  : "Automatic comfort"}
          </div>
          <div className="bh-thermostat">
            <div className="bh-dial-ticks" />
            <div className="bh-dial-center">
              {mode === "heat_cool" ? (
                <div className="bh-range">
                  <Tap
                    selected={rangeSide === "low"}
                    onClick={() => setRangeSide("low")}
                    label="Select heating limit"
                  >
                    <small>HEAT TO</small>
                    {range.low}°
                  </Tap>
                  <Tap
                    selected={rangeSide === "high"}
                    onClick={() => setRangeSide("high")}
                    label="Select cooling limit"
                  >
                    <small>COOL TO</small>
                    {range.high}°
                  </Tap>
                </div>
              ) : (
                <>
                  <span className="bh-set-label">{mode === "off" ? "LAST SET TO" : "SET TO"}</span>
                  <div className="bh-target">
                    {target}
                    <sup>°</sup>
                  </div>
                </>
              )}
              <span className="bh-ambient">Inside 74°</span>
            </div>
          </div>
          <div className="bh-stepper">
            <Tap disabled={mode === "off"} onClick={() => step(-1)} label="Decrease temperature">
              <Minus size={26} />
            </Tap>
            <span>
              {mode === "heat_cool"
                ? `Adjust ${rangeSide === "low" ? "heating" : "cooling"} limit`
                : "Make yourself comfortable"}
            </span>
            <Tap disabled={mode === "off"} onClick={() => step(1)} label="Increase temperature">
              <Plus size={26} />
            </Tap>
          </div>
          <div className="bh-modes">
            {Object.entries(MODES).map(([key, label]) => (
              <Tap
                key={key}
                selected={key === mode}
                onClick={() => {
                  if (key === "off" || key === "cool" || key === "heat" || key === "heat_cool")
                    setMode(key);
                  preview(
                    `${label} mode${key === "heat_cool" ? " · range shown for design exploration" : ""}`,
                  );
                }}
              >
                {key === "off" ? (
                  <Power size={17} />
                ) : key === "cool" ? (
                  <Snowflake size={17} />
                ) : key === "heat" ? (
                  <Sun size={17} />
                ) : (
                  <Wind size={17} />
                )}
                {label}
              </Tap>
            ))}
          </div>
        </section>
        <section className="bh-card bh-sonos">
          <div className="bh-card-head">
            <div className="bh-heading">
              <AudioLines />
              <h2>Sound, everywhere</h2>
            </div>
            <span className="bh-sonos-wordmark">SONOS</span>
          </div>
          <div className="bh-source">
            <div className="bh-source-art">
              {source === "line-in" ? (
                <AudioLines size={37} strokeWidth={1.3} />
              ) : (
                <Tv size={35} strokeWidth={1.3} />
              )}
            </div>
            <div>
              <h3>{source === "line-in" ? "Desk line-in" : "TV audio"}</h3>
              <p>
                {source === "line-in" ? "5 rooms grouped · Paused" : "All rooms grouped · Preview"}
              </p>
            </div>
          </div>
          <div className="bh-volume">
            <Volume2 size={21} />
            <label className="bh-sr" htmlFor="bh-volume">
              Desk volume
            </label>
            <input
              id="bh-volume"
              aria-label="Desk volume"
              type="range"
              min="0"
              max="100"
              value={volume}
              onChange={(e) => {
                setVolume(Number(e.target.value));
                preview(`Desk volume ${e.target.value}%`);
              }}
            />
            <span>{volume}%</span>
          </div>
          <div className="bh-sonos-actions">
            <Tap
              selected={source === "line-in"}
              onClick={() => {
                setSource("line-in");
                preview("All rooms joined to Desk line-in");
              }}
            >
              <Plug size={17} />
              Join all to line-in{source === "line-in" && <Check size={16} />}
            </Tap>
            <Tap
              selected={source === "tv"}
              onClick={() => {
                setSource("tv");
                preview("All rooms joined to TV");
              }}
            >
              <Tv size={17} />
              Join all to TV
            </Tap>
          </div>
        </section>
        <section className="bh-card bh-weather">
          <div className="bh-card-head">
            <span className="bh-eyebrow">Outside today</span>
            <CloudRain size={26} strokeWidth={1.5} />
          </div>
          <div className="bh-weather-temp">67°</div>
          <h3>Slight rain</h3>
          <div className="bh-weather-range">
            <span>
              <ArrowUp size={14} />
              77°
            </span>
            <span>
              <ArrowDown size={14} />
              65°
            </span>
          </div>
          <div className="bh-weather-foot">
            Feels like 73°<span>Rain 84%</span>
          </div>
        </section>
        <section className="bh-card bh-forecast">
          <div className="bh-card-head">
            <div>
              <h2>The day ahead</h2>
              <p>Temperature over the next 12 hours</p>
            </div>
            <span className="bh-forecast-unit">°F</span>
          </div>
          <svg
            className="bh-chart"
            viewBox="0 0 790 140"
            role="img"
            aria-label="Hourly forecast: 67 degrees now, rising to 77 at 4 PM, then falling to 72 by 10 PM"
          >
            <defs>
              <linearGradient id="bh-area" x1="0" x2="0" y1="0" y2="1">
                <stop offset="0" stopColor="#a8c7c7" stopOpacity=".25" />
                <stop offset="1" stopColor="#a8c7c7" stopOpacity="0" />
              </linearGradient>
            </defs>
            <path
              d={`M 25 109 ${HOURS.map((h, i) => `L ${25 + i * 67} ${95 - (h.temp - 65) * 5}`).join(" ")} L 762 109 Z`}
              fill="url(#bh-area)"
            />
            <line x1="25" y1="108" x2="762" y2="108" stroke="#e9edec" />
            <polyline
              points={HOURS.map((h, i) => `${25 + i * 67},${95 - (h.temp - 65) * 5}`).join(" ")}
              fill="none"
              stroke="#669292"
              strokeWidth="2.5"
              strokeLinejoin="round"
            />
            {HOURS.map((h, i) => (
              <g key={h.label}>
                <circle
                  cx={25 + i * 67}
                  cy={95 - (h.temp - 65) * 5}
                  r={i === 0 ? 4 : 2.5}
                  fill="#669292"
                />
                <text
                  x={25 + i * 67}
                  y={79 - (h.temp - 65) * 5}
                  textAnchor="middle"
                  className="bh-chart-value"
                >
                  {h.temp}°
                </text>
                <text x={25 + i * 67} y="132" textAnchor="middle">
                  {h.label}
                </text>
              </g>
            ))}
          </svg>
        </section>
      </div>
      <footer className="bh-footer">
        <span>
          DESIGN STUDY <span className="bh-footer-separator">/</span> 01 — Soft white
        </span>
        <span aria-live="polite">{notice}</span>
        <span>Preview controls only</span>
      </footer>
    </main>
  );
}
