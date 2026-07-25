# ESPHome devices

Firmware configs for the ESP32s in the flat. Versioned here because the previous
config for `ble-proxy` lived only in `/tmp` on the mini and was lost to
a reboot — leaving a load-bearing house device unreproducible.

## Devices

| Device              | Hardware            | IP            | Role                                                     |
| ------------------- | ------------------- | ------------- | -------------------------------------------------------- |
| `ble-proxy` | Seeed XIAO ESP32-C6 | 192.168.0.211 | The only **connectable** BLE proxy in the flat (see below) |

### Why `ble-proxy` matters

HA's Renpho scale integration declares `connectable: true` — it must open a GATT
connection to read a weigh-in. The Shelly BLE proxies are **advertisement-only**
and can never do this ([HA Bluetooth docs][ha-bt] list Shelly Gen2+ active
connections as "not supported"). macOS is not a supported Bluetooth host at all,
and remote adapters are limited to ESPHome and Shelly. So this ESP32 is the only
device in the house that can read the scale, and the weight tile goes dark
without it.

### Antenna selection (XIAO ESP32-C6)

The XIAO ESP32-C6 has an FM8625H RF switch between its onboard ceramic antenna
and a u.FL connector, controlled by two pins:

| Pin      | Alias            | Meaning                                        |
| -------- | ---------------- | ---------------------------------------------- |
| `GPIO3`  | `RF_SWITCH_EN`   | Drive **LOW** to enable the RF switch          |
| `GPIO14` | `RF_ANT_SELECT`  | **LOW** = onboard ceramic, **HIGH** = external |

Leave these undriven and the radio is effectively deaf. Measured symptom: the
proxy heard a scale **in the same room** at -99 dBm while a Shelly in a
*different* room heard it at -75 — a 24 dB deficit that placement cannot
explain. Diagnose by comparing per-scanner RSSI for devices heard by several
scanners (`all_history` in the bluetooth config-entry diagnostics).

A/B measured 2026-07-22, same physical location, only the GPIO block changed:

|                    | WiFi RSSI | BLE devices seen | median BLE RSSI vs Shellys |
| ------------------ | --------- | ---------------- | -------------------------- |
| without GPIO block | -68 dB    | 38               | -11 dB                     |
| with GPIO block    | -46 dB    | 60               | +4 dB                      |

After the fix a scale weigh-in was read and ingested on the first attempt, having
produced nothing at all for the preceding month.

Only set `rf_ant_select` HIGH if a physical u.FL antenna is actually fitted.

## Flashing safely

**Flash over USB, not OTA, whenever the change could affect connectivity** —
antenna/RF pins, WiFi settings, board or framework changes. An OTA that takes the
device off the network can only be recovered by physically fetching it.

Check the secrets actually resolved before flashing. A build that silently used
placeholder secrets will compile and upload perfectly and then fail to join WiFi:

```
Disconnected ssid='placeholder-ssid' reason='Probe Request Unsuccessful'
```

Confirm with `grep wifi_ssid secrets.yaml` in the directory you are flashing from.

## Flashing

ESPHome is run via `uvx`, so there is nothing to install:

```sh
~/.local/bin/uvx esphome run infra/esphome/ble-proxy.yaml --device 192.168.0.211
```

### Secrets

The config uses `!secret wifi_ssid` / `!secret wifi_password`, which ESPHome
reads from a `secrets.yaml` **next to the config**. That file is deliberately not
committed.

The device is on the main SSID `world-wide-webb`. Note that the SOPS vault
carries only `WIFI_MAIN_CREDENTIALS__SSID` — the main network's *password* is not
in it (`WIFI_PASSWORD` derives from `WIFI_GUEST_WIFI_PASSWORD`, the guest
network). So the main password must come from 1Password, which needs to be
unlocked.

Write a throwaway `secrets.yaml` outside the repo, run the flash from there, and
delete it afterwards.

### Notes

- The API is **plaintext** (`noise_psk: ""` in the HA config entry) and OTA has
  **no password**. Adding either breaks the existing HA entry until re-paired.
- HA keys the config entry off `name:`. This device was renamed
  `ble-proxy-bathroom` → `ble-proxy-desk` (2026-07-23) → `ble-proxy`
  (2026-07-25, dropped the location suffix after the hardware moved again —
  see git history for where); each rename orphans the old esphome config
  entry in HA, so after flashing, delete the stale entry and add the newly
  discovered `ble-proxy` node (plaintext API, empty noise_psk). The scale
  entity id (`HA_WEIGHT_ENTITY_ID`) is unaffected — it belongs to the Renpho
  integration, not this proxy.
- If an OTA flash bricks the WiFi config, recover over USB with
  `uvx esphome run <config> --device /dev/cu.usbmodem101`.

[ha-bt]: https://www.home-assistant.io/integrations/bluetooth/
