# RM-LVI Home Assistant Add-ons

Home Assistant add-on repository.

## Add-ons

### [Starling Connect Bridge](./starling_connect)

Read-only bridge from a **Starling Home Hub** (Developer Connect API) into Home
Assistant via **MQTT discovery**. Exposes, as native HA entities:

- **Doorbell press** — fast-polled (~1 s) `binary_sensor`, independent of the
  Nest→Starling→HomeKit path.
- **Camera online status** — a connectivity `binary_sensor` per camera, for
  reliable offline alerts.
- **Locks** — state, battery level, battery-low, and online.
- **Home/away** — an occupancy `binary_sensor`.

## Installing

1. In Home Assistant: **Settings → Add-ons → Add-on Store → ⋮ → Repositories**.
2. Add: `https://github.com/RM-LVI/hassio-starling-connect`
3. Install **Starling Connect Bridge**, set the options (hub IP + API key), start.

Requires the **MQTT integration** (e.g. the Mosquitto broker add-on).

The add-on is fully config-driven — no hub address, key, or device names are
stored in this repository.
