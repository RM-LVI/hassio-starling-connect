'use strict';

// Starling Home Hub (Developer Connect API) -> Home Assistant MQTT discovery.
// Read-only. All instance data (hub host, API key, device names) comes from the
// add-on options and the hub at runtime — nothing home-specific is hardcoded.

const fs = require('fs');
const mqtt = require('mqtt');

// ---------- options ----------
let OPTIONS = {};
try {
  OPTIONS = JSON.parse(fs.readFileSync('/data/options.json', 'utf8'));
} catch (e) {
  console.error('[error] cannot read /data/options.json:', e.message);
  process.exit(1);
}

const LEVELS = { trace: 0, debug: 1, info: 2, warning: 3, error: 4 };
const MINLVL = LEVELS[OPTIONS.log_level] ?? LEVELS.info;
const log = (lvl, ...a) => {
  if ((LEVELS[lvl] ?? LEVELS.info) >= MINLVL) console.log(`[${lvl}]`, ...a);
};

const HUB = String(OPTIONS.hub_host || '').trim();
const KEY = String(OPTIONS.api_key || '').trim();
const PREFIX = String(OPTIONS.discovery_prefix || 'homeassistant').trim() || 'homeassistant';
const FAST_MS = Math.max(1, Number(OPTIONS.doorbell_poll_seconds) || 1) * 1000;
const SLOW_MS = Math.max(5, Number(OPTIONS.slow_poll_seconds) || 60) * 1000;
const SUP = process.env.SUPERVISOR_TOKEN;

if (!HUB || !KEY) {
  log('error', 'hub_host and api_key are required in the add-on configuration.');
  process.exit(1);
}

const API = `http://${HUB}:3080/api/connect/v1`;
const NS = 'starling';
const AVAIL = `${NS}/bridge/availability`;

// ---------- helpers ----------
async function api(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${API}${path}${sep}key=${encodeURIComponent(KEY)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`Starling API HTTP ${res.status} for ${path}`);
  return res.json();
}

async function mqttConfig() {
  const res = await fetch('http://supervisor/services/mqtt', {
    headers: { Authorization: `Bearer ${SUP}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Supervisor MQTT service HTTP ${res.status}`);
  return (await res.json()).data;
}

let client = null;
const pub = (topic, payload, opts = { retain: true, qos: 0 }) => {
  if (client) client.publish(topic, String(payload), opts);
};

const bridgeDevice = {
  identifiers: [`${NS}_bridge`],
  name: 'Starling Connect Bridge',
  manufacturer: 'Starling',
  model: 'Connect API bridge',
};

function deviceBlock(dev) {
  return {
    identifiers: [`${NS}_${dev.id}`],
    name: dev.name || dev.id,
    manufacturer: 'Starling',
    model: dev.type,
    via_device: `${NS}_bridge`,
  };
}

// name is the ROLE only (e.g. "Online"); has_entity_name lets HA compose
// "<device name> <role>" so names never double up. Pass a falsy name to make
// the entity take the device name verbatim (single-feature devices).
function discBinary(dev, key, name, extra = {}) {
  const uid = `${NS}_${dev.id}_${key}`;
  const cfg = {
    unique_id: uid,
    has_entity_name: true,
    state_topic: `${NS}/${dev.id}/${key}`,
    payload_on: 'true',
    payload_off: 'false',
    availability_topic: AVAIL,
    payload_available: 'online',
    payload_not_available: 'offline',
    device: deviceBlock(dev),
    ...extra,
  };
  if (name) cfg.name = name;
  pub(`${PREFIX}/binary_sensor/${uid}/config`, JSON.stringify(cfg));
}

function discSensor(dev, key, name, extra = {}) {
  const uid = `${NS}_${dev.id}_${key}`;
  const cfg = {
    unique_id: uid,
    has_entity_name: true,
    state_topic: `${NS}/${dev.id}/${key}`,
    availability_topic: AVAIL,
    payload_available: 'online',
    payload_not_available: 'offline',
    device: deviceBlock(dev),
    ...extra,
  };
  if (name) cfg.name = name;
  pub(`${PREFIX}/sensor/${uid}/config`, JSON.stringify(cfg));
}

function discBridge() {
  const uid = `${NS}_bridge_connected_to_nest`;
  pub(
    `${PREFIX}/binary_sensor/${uid}/config`,
    JSON.stringify({
      name: 'Connected to Nest',
      has_entity_name: true,
      unique_id: uid,
      state_topic: `${NS}/bridge/connectedToNest`,
      payload_on: 'true',
      payload_off: 'false',
      availability_topic: AVAIL,
      payload_available: 'online',
      payload_not_available: 'offline',
      device_class: 'connectivity',
      entity_category: 'diagnostic',
      device: bridgeDevice,
    })
  );
}

// ---------- discovery ----------
const knownDevices = new Map(); // id -> {id,name,type}
let doorbellIds = new Set();

async function buildDiscovery() {
  const list = (await api('/devices')).devices || [];
  const nextDoorbells = new Set();
  for (const item of list) {
    let detail;
    try {
      detail = await api(`/devices/${item.id}`);
    } catch (e) {
      log('warning', `detail fetch failed for ${item.name}: ${e.message}`);
      continue;
    }
    const p = detail.properties || {};
    const d = { id: p.id || item.id, name: p.name || item.name, type: p.type || item.type };
    knownDevices.set(d.id, d);

    if (d.type === 'cam') {
      discBinary(d, 'isOnline', 'Online', {
        device_class: 'connectivity',
        entity_category: 'diagnostic',
      });
      if ('doorbellPushed' in p) {
        nextDoorbells.add(d.id);
        discBinary(d, 'doorbellPushed', 'Doorbell');
      }
    } else if (d.type === 'lock') {
      discSensor(d, 'currentState', 'State');
      discSensor(d, 'batteryLevel', 'Battery', {
        device_class: 'battery',
        unit_of_measurement: '%',
        state_class: 'measurement',
        entity_category: 'diagnostic',
      });
      discBinary(d, 'batteryLow', 'Battery Low', {
        device_class: 'battery',
        entity_category: 'diagnostic',
      });
      discBinary(d, 'isOnline', 'Online', {
        device_class: 'connectivity',
        entity_category: 'diagnostic',
      });
    } else if (d.type === 'home_away_control') {
      // Single-feature device — omit role so it takes the device name.
      discBinary(d, 'homeState', null, { device_class: 'occupancy' });
    } else {
      log('debug', `no v1 mapping for device type '${d.type}' (${d.name})`);
    }
  }
  doorbellIds = nextDoorbells;
  log('info', `discovery published for ${knownDevices.size} device(s), ${doorbellIds.size} doorbell(s)`);
}

// ---------- state ----------
function publishDeviceState(dev, p) {
  if (dev.type === 'cam') {
    if ('isOnline' in p) pub(`${NS}/${dev.id}/isOnline`, !!p.isOnline);
    if ('doorbellPushed' in p) pub(`${NS}/${dev.id}/doorbellPushed`, !!p.doorbellPushed);
  } else if (dev.type === 'lock') {
    if ('currentState' in p) pub(`${NS}/${dev.id}/currentState`, p.currentState);
    if ('batteryLevel' in p) pub(`${NS}/${dev.id}/batteryLevel`, p.batteryLevel);
    if ('batteryStatus' in p) pub(`${NS}/${dev.id}/batteryLow`, p.batteryStatus === 'low');
    if ('isOnline' in p) pub(`${NS}/${dev.id}/isOnline`, !!p.isOnline);
  } else if (dev.type === 'home_away_control') {
    if ('homeState' in p) pub(`${NS}/${dev.id}/homeState`, !!p.homeState);
  }
}

async function slowPoll() {
  try {
    const list = (await api('/devices')).devices || [];
    for (const item of list) {
      try {
        const detail = await api(`/devices/${item.id}`);
        const d = knownDevices.get(item.id) || { id: item.id, name: item.name, type: item.type };
        publishDeviceState(d, detail.properties || {});
      } catch (e) {
        log('warning', `slow poll device ${item.name}: ${e.message}`);
      }
    }
    try {
      const s = await api('/status');
      pub(`${NS}/bridge/connectedToNest`, !!s.connectedToNest);
    } catch (e) {
      log('debug', `status poll: ${e.message}`);
    }
    pub(AVAIL, 'online');
  } catch (e) {
    // Hub unreachable — mark everything unavailable rather than showing stale state.
    log('error', `slow poll failed (hub unreachable?): ${e.message}`);
    pub(AVAIL, 'offline');
  }
}

async function fastPoll() {
  for (const id of doorbellIds) {
    try {
      const r = await api(`/devices/${id}/doorbellPushed`);
      const v = r && r.properties ? !!r.properties.doorbellPushed : false;
      pub(`${NS}/${id}/doorbellPushed`, v);
    } catch (e) {
      log('debug', `fast poll ${id}: ${e.message}`);
    }
  }
}

// ---------- main ----------
async function main() {
  const m = await mqttConfig();
  const proto = m.ssl ? 'mqtts' : 'mqtt';
  const url = `${proto}://${m.host}:${m.port}`;
  log('info', `connecting to MQTT at ${url}`);

  client = mqtt.connect(url, {
    username: m.username,
    password: m.password,
    reconnectPeriod: 5000,
    will: { topic: AVAIL, payload: 'offline', retain: true, qos: 0 },
  });

  client.on('connect', async () => {
    log('info', 'MQTT connected');
    pub(AVAIL, 'online');
    try {
      discBridge();
      await buildDiscovery();
      await slowPoll();
    } catch (e) {
      log('error', `initial discovery/poll: ${e.message}`);
    }
  });
  client.on('error', (e) => log('error', `MQTT error: ${e.message}`));
  client.on('reconnect', () => log('debug', 'MQTT reconnecting...'));

  setInterval(() => fastPoll().catch((e) => log('debug', `fastPoll: ${e.message}`)), FAST_MS);
  setInterval(() => slowPoll().catch((e) => log('debug', `slowPoll: ${e.message}`)), SLOW_MS);
  // Re-publish discovery periodically to pick up added/renamed devices.
  setInterval(() => buildDiscovery().catch((e) => log('warning', `rediscovery: ${e.message}`)), 10 * 60 * 1000);
}

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    try {
      pub(AVAIL, 'offline');
      if (client) client.end();
    } catch (e) {
      // ignore
    }
    process.exit(0);
  });
}

main().catch((e) => {
  log('error', `fatal: ${e.message}`);
  process.exit(1);
});
