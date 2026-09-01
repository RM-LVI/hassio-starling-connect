'use strict';

// Starling Home Hub (Developer Connect API) -> Home Assistant via MQTT discovery.
// Sensors + controls (locks, camera switches). Read polls + write-through commands.
// Fully config-driven; nothing home-specific is hardcoded.

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

// Device properties that are metadata, not states.
const META = new Set(['id', 'name', 'type', 'serialNumber', 'structureName', 'where', 'supportsStreaming']);
// Writable camera properties -> HA switches.
const CAM_SWITCHES = new Set(['cameraEnabled', 'quietTime']);
// Binary-sensor device_class hints.
const BIN_DC = { isOnline: 'connectivity', motionDetected: 'motion', personDetected: 'occupancy' };

const slug = (s) =>
  String(s).replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').toLowerCase();

// A single API property -> a topic-safe key (colons/spaces in face/zone keys).
function topicKeyFor(prop) {
  if (prop.startsWith('faceDetected:')) return 'face_' + slug(prop.slice(13));
  if (prop.startsWith('zoneActivityDetected:')) return 'zone_' + slug(prop.slice(21));
  return prop; // fixed keys are already topic-safe
}

const FIXED_ROLE = {
  isOnline: 'Online',
  motionDetected: 'Motion',
  personDetected: 'Person',
  animalDetected: 'Animal',
  vehicleDetected: 'Vehicle',
  packageDelivered: 'Package Delivered',
  packageRetrieved: 'Package Retrieved',
  doorbellPushed: 'Doorbell',
  cameraEnabled: 'Camera Enabled',
  quietTime: 'Quiet Time',
  batteryLevel: 'Battery',
  lastLockUnlockMethod: 'Last Unlock Method',
};
function roleFor(prop) {
  if (prop.startsWith('faceDetected:')) return 'Face ' + prop.slice(13);
  if (prop.startsWith('zoneActivityDetected:')) return 'Zone ' + prop.slice(21);
  return FIXED_ROLE[prop] || prop;
}

// ---------- HTTP ----------
async function apiGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const res = await fetch(`${API}${path}${sep}key=${encodeURIComponent(KEY)}`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Starling API HTTP ${res.status} for ${path}`);
  return res.json();
}

async function apiPost(id, body) {
  const res = await fetch(`${API}/devices/${id}?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Starling write HTTP ${res.status}`);
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

// ---------- MQTT ----------
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

const AVAIL_FIELDS = {
  availability_topic: AVAIL,
  payload_available: 'online',
  payload_not_available: 'offline',
};

function discBinary(dev, tkey, role, extra = {}) {
  const uid = `${NS}_${dev.id}_${tkey}`;
  const cfg = {
    unique_id: uid,
    has_entity_name: true,
    state_topic: `${NS}/${dev.id}/${tkey}`,
    payload_on: 'true',
    payload_off: 'false',
    ...AVAIL_FIELDS,
    device: deviceBlock(dev),
    ...extra,
  };
  if (role) cfg.name = role;
  pub(`${PREFIX}/binary_sensor/${uid}/config`, JSON.stringify(cfg));
}

function discSensor(dev, tkey, role, extra = {}) {
  const uid = `${NS}_${dev.id}_${tkey}`;
  const cfg = {
    unique_id: uid,
    has_entity_name: true,
    state_topic: `${NS}/${dev.id}/${tkey}`,
    ...AVAIL_FIELDS,
    device: deviceBlock(dev),
    ...extra,
  };
  if (role) cfg.name = role;
  pub(`${PREFIX}/sensor/${uid}/config`, JSON.stringify(cfg));
}

// commandMap: "<id>/<tkey>" -> { property, type:'bool'|'lock' }
const commandMap = new Map();

function discSwitch(dev, prop) {
  const tkey = topicKeyFor(prop);
  const uid = `${NS}_${dev.id}_${tkey}`;
  const cfg = {
    unique_id: uid,
    has_entity_name: true,
    name: roleFor(prop),
    state_topic: `${NS}/${dev.id}/${tkey}`,
    command_topic: `${NS}/${dev.id}/set/${tkey}`,
    payload_on: 'true',
    payload_off: 'false',
    ...AVAIL_FIELDS,
    device: deviceBlock(dev),
  };
  pub(`${PREFIX}/switch/${uid}/config`, JSON.stringify(cfg));
  commandMap.set(`${dev.id}/${tkey}`, { property: prop, type: 'bool' });
}

function discLock(dev) {
  // Clear the 0.1.x "State" sensor for this lock so it doesn't orphan.
  pub(`${PREFIX}/sensor/${NS}_${dev.id}_currentState/config`, '');
  const uid = `${NS}_${dev.id}_lock`;
  const cfg = {
    unique_id: uid,
    has_entity_name: true, // no name -> takes the device (lock) name
    state_topic: `${NS}/${dev.id}/currentState`,
    command_topic: `${NS}/${dev.id}/set/lock`,
    payload_lock: 'LOCK',
    payload_unlock: 'UNLOCK',
    state_locked: 'locked',
    state_unlocked: 'unlocked',
    ...AVAIL_FIELDS,
    device: deviceBlock(dev),
  };
  pub(`${PREFIX}/lock/${uid}/config`, JSON.stringify(cfg));
  commandMap.set(`${dev.id}/lock`, { property: 'targetState', type: 'lock' });
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
      ...AVAIL_FIELDS,
      device_class: 'connectivity',
      entity_category: 'diagnostic',
      device: bridgeDevice,
    })
  );
}

// ---------- discovery ----------
const knownDevices = new Map(); // id -> {id,name,type}
let doorbellIds = new Set();

function buildDeviceDiscovery(d, p) {
  if (d.type === 'cam') {
    for (const prop of Object.keys(p)) {
      if (META.has(prop)) continue;
      if (CAM_SWITCHES.has(prop)) {
        discSwitch(d, prop);
        continue;
      }
      if (typeof p[prop] === 'boolean') {
        const extra = {};
        const dc = BIN_DC[prop];
        if (dc) extra.device_class = dc;
        if (prop === 'isOnline') extra.entity_category = 'diagnostic';
        discBinary(d, topicKeyFor(prop), roleFor(prop), extra);
        if (prop === 'doorbellPushed') doorbellIds.add(d.id);
      }
    }
  } else if (d.type === 'lock') {
    discLock(d);
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
    if ('lastLockUnlockMethod' in p) {
      discSensor(d, 'lastLockUnlockMethod', 'Last Unlock Method', { entity_category: 'diagnostic' });
    }
  } else if (d.type === 'home_away_control') {
    discBinary(d, 'homeState', null, { device_class: 'occupancy' });
  } else {
    log('debug', `no mapping for device type '${d.type}' (${d.name})`);
  }
}

async function buildDiscovery() {
  const list = (await apiGet('/devices')).devices || [];
  doorbellIds = new Set();
  for (const item of list) {
    let detail;
    try {
      detail = await apiGet(`/devices/${item.id}`);
    } catch (e) {
      log('warning', `detail fetch failed for ${item.name}: ${e.message}`);
      continue;
    }
    const p = detail.properties || {};
    const d = { id: p.id || item.id, name: p.name || item.name, type: p.type || item.type };
    knownDevices.set(d.id, d);
    buildDeviceDiscovery(d, p);
  }
  log('info', `discovery published for ${knownDevices.size} device(s), ${doorbellIds.size} doorbell(s)`);
}

// ---------- state ----------
function publishAll(dev, p) {
  for (const [k, v] of Object.entries(p)) {
    if (META.has(k)) continue;
    const tk = topicKeyFor(k);
    pub(`${NS}/${dev.id}/${tk}`, typeof v === 'boolean' ? (v ? 'true' : 'false') : v);
  }
  if ('batteryStatus' in p) {
    pub(`${NS}/${dev.id}/batteryLow`, p.batteryStatus === 'low' ? 'true' : 'false');
  }
}

async function refreshDevice(id) {
  const detail = await apiGet(`/devices/${id}`);
  const d = knownDevices.get(id) || { id, name: id, type: (detail.properties || {}).type };
  publishAll(d, detail.properties || {});
}

async function slowPoll() {
  try {
    const list = (await apiGet('/devices')).devices || [];
    for (const item of list) {
      try {
        await refreshDevice(item.id);
      } catch (e) {
        log('warning', `slow poll device ${item.name}: ${e.message}`);
      }
    }
    try {
      const s = await apiGet('/status');
      pub(`${NS}/bridge/connectedToNest`, !!s.connectedToNest);
    } catch (e) {
      log('debug', `status poll: ${e.message}`);
    }
    pub(AVAIL, 'online');
  } catch (e) {
    log('error', `slow poll failed (hub unreachable?): ${e.message}`);
    pub(AVAIL, 'offline');
  }
}

// Doorbell cams: poll the FULL device fast so face/person identity is current
// at the moment the button is pressed (announcements read it right away).
async function fastPoll() {
  for (const id of doorbellIds) {
    try {
      await refreshDevice(id);
    } catch (e) {
      log('debug', `fast poll ${id}: ${e.message}`);
    }
  }
}

// ---------- commands ----------
async function handleCommand(topic, payload) {
  // starling/<id>/set/<tkey...>
  const parts = topic.split('/');
  if (parts.length < 4 || parts[0] !== NS || parts[2] !== 'set') return;
  const id = parts[1];
  const tkey = parts.slice(3).join('/');
  const entry = commandMap.get(`${id}/${tkey}`);
  if (!entry) {
    log('warning', `no command mapping for ${topic}`);
    return;
  }
  const val = String(payload).trim();
  let body;
  if (entry.type === 'lock') {
    body = { [entry.property]: val.toUpperCase() === 'LOCK' ? 'locked' : 'unlocked' };
  } else {
    const on = val === 'true' || val.toUpperCase() === 'ON';
    body = { [entry.property]: on };
  }
  try {
    await apiPost(id, body);
    log('info', `set ${id} ${JSON.stringify(body)}`);
    setTimeout(() => refreshDevice(id).catch(() => {}), 600);
  } catch (e) {
    log('error', `command ${topic}: ${e.message}`);
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
    client.subscribe(`${NS}/+/set/#`, (e) => e && log('error', `subscribe: ${e.message}`));
    try {
      discBridge();
      await buildDiscovery();
      await slowPoll();
    } catch (e) {
      log('error', `initial discovery/poll: ${e.message}`);
    }
  });
  client.on('message', (topic, payload) =>
    handleCommand(topic, payload).catch((e) => log('error', `command handler: ${e.message}`))
  );
  client.on('error', (e) => log('error', `MQTT error: ${e.message}`));
  client.on('reconnect', () => log('debug', 'MQTT reconnecting...'));

  setInterval(() => fastPoll().catch((e) => log('debug', `fastPoll: ${e.message}`)), FAST_MS);
  setInterval(() => slowPoll().catch((e) => log('debug', `slowPoll: ${e.message}`)), SLOW_MS);
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
