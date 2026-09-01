# Starling Connect Bridge

Read-only bridge from a Starling Home Hub's **Developer Connect API** into Home
Assistant over **MQTT discovery**. Entities are created automatically; nothing
needs to be added to `configuration.yaml`.

## Requirements

- An MQTT broker configured in Home Assistant (e.g. the **Mosquitto broker**
  add-on). This add-on requests MQTT service info from the Supervisor
  automatically — no manual broker credentials needed.
- A Starling Home Hub reachable on your network, with the **Developer Connect
  API enabled** and an **API key** (Starling app → Developer Connect). A
  read-only key is sufficient.

## Configuration

| Option | Default | Description |
|---|---|---|
| `hub_host` | — | Starling hub IP or hostname (e.g. `192.168.1.20`). |
| `api_key` | — | Developer Connect API key. |
| `doorbell_poll_seconds` | `1` | How often the doorbell-press state is polled. The Connect API holds `doorbellPushed` true for a few seconds per press, so 1–2 s reliably catches it. |
| `slow_poll_seconds` | `60` | How often cameras/locks/home-away are polled. |
| `discovery_prefix` | `homeassistant` | MQTT discovery prefix (match your MQTT integration if changed). |
| `log_level` | `info` | `trace`, `debug`, `info`, `warning`, `error`. |

## Entities created

Grouped under one HA **device per Starling device**, plus a bridge device.

- **Cameras:** `<name> Online` (connectivity). Doorbell cameras also get
  `<name> Doorbell` — turns **on** for the few seconds the button is held.
- **Locks:** `<name> State`, `<name> Battery` (%), `<name> Battery Low`,
  `<name> Online`.
- **Home/away:** `<name>` occupancy sensor.
- **Bridge:** `Starling Hub Connected to Nest` (connectivity). The whole set
  goes *unavailable* if the bridge stops or the hub becomes unreachable
  (MQTT availability / LWT).

## Example automations

**Doorbell → do something** (replace the entity id with your doorbell):

```yaml
triggers:
  - trigger: state
    entity_id: binary_sensor.front_door_doorbell
    to: "on"
```

**Camera offline for 5 minutes → notify:**

```yaml
triggers:
  - trigger: state
    entity_id: binary_sensor.front_door_online
    to: "off"
    for: "00:05:00"
```

## Notes

- **Read-only.** The bridge only reads from the hub and publishes state.
- Port `3080` on the hub is plain HTTP; the API key is sent as a query
  parameter, so keep it on a trusted LAN.
