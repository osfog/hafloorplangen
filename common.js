/* eslint-disable no-console */
/**
 * Helpers shared by genfloorplan.js and exportboundary.js: reading SVG files,
 * prompting, and the Home Assistant REST and WebSocket APIs.
 */
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const { DOMParser } = require('@xmldom/xmldom');
const { execSync } = require('child_process');

const FLOORPLAN_CARD_TYPE = 'custom:floorplan-card';

const namespaces = {
  inkscape: 'http://www.inkscape.org/namespaces/inkscape',
  sodipodi: 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
  svg: 'http://www.w3.org/2000/svg',
  // marks elements created by genfloorplan.js, used to find entities removed from HA
  hafloorplan: 'http://www.example.com/hafloorplan',
};

// errors caused by bad input, printed without a stack trace
class UserError extends Error {}

// generate a random string of the given length
const randomString = (length) => {
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i += 1) {
    result += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return result;
};

// ask a yes/no question on the terminal, defaults to no
const confirm = (question) => {
  try {
    // the question is passed through the environment so it is never parsed by the shell
    const answer = execSync('sh -c \'read -p "$QUESTION (y/N): " ans; echo "$ans"\'', {
      stdio: ['inherit', 'pipe', 'inherit'],
      env: { ...process.env, QUESTION: question },
    })
      .toString()
      .trim()
      .toLowerCase();
    return answer === 'y' || answer === 'yes';
  } catch {
    console.error('Interactive prompt failed (possibly non-Unix shell), answering no.');
    return false;
  }
};

const readSvg = (fileName) => {
  let xmlFile;
  try {
    xmlFile = fs.readFileSync(fileName, 'utf8');
  } catch (err) {
    throw new UserError(`Could not read SVG file ${fileName}: ${err.message}`);
  }
  // declare the hafloorplan namespace on the root, files written by earlier
  // versions used the prefix without declaring it which fails to parse
  if (!xmlFile.includes('xmlns:hafloorplan=')) {
    xmlFile = xmlFile.replace(
      /<svg(\s|>)/,
      `<svg xmlns:hafloorplan="${namespaces.hafloorplan}"$1`,
    );
  }
  try {
    return new DOMParser().parseFromString(xmlFile, 'text/xml');
  } catch (err) {
    throw new UserError(`Could not parse SVG file ${fileName}: ${err.message}`);
  }
};

const parseServerUrl = (serverUrl) => {
  let baseUrl;
  try {
    baseUrl = new URL(serverUrl.endsWith('/') ? serverUrl : `${serverUrl}/`);
  } catch {
    throw new UserError(`Invalid URL: ${serverUrl}`);
  }
  if (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') {
    throw new UserError(`Invalid protocol ${baseUrl.protocol}, use http or https`);
  }
  return baseUrl;
};

// fetch the state of all entities from the Home Assistant REST API
const fetchEntities = async (baseUrl, token) => {
  console.log('Fetching entities from Home Assistant');
  let response;
  try {
    response = await fetch(new URL('api/states', baseUrl), {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    throw new UserError(
      `Could not connect to Home Assistant at ${baseUrl}: ${err.cause ? err.cause.message : err.message}`,
    );
  }
  if (response.status === 401) {
    throw new UserError('Home Assistant rejected the token (401 Unauthorized), check the long lived token');
  }
  if (!response.ok) {
    throw new UserError(`Home Assistant responded with ${response.status} ${response.statusText}`);
  }

  let entities;
  try {
    entities = await response.json();
  } catch (err) {
    throw new UserError(`Unexpected response from Home Assistant, check the url: ${err.message}`);
  }
  if (!Array.isArray(entities)) {
    throw new UserError('Unexpected response from Home Assistant, check the url');
  }
  return entities;
};

// connect and authenticate to the Home Assistant WebSocket API, resolves to
// { call, close } where call(type, data) sends a command and resolves to its result
const connectWebSocket = (baseUrl, token) => new Promise((resolve, reject) => {
  if (typeof WebSocket === 'undefined') {
    reject(new UserError('--card needs Node.js 22 or later (built-in WebSocket)'));
    return;
  }
  const wsUrl = new URL('api/websocket', baseUrl);
  wsUrl.protocol = baseUrl.protocol === 'https:' ? 'wss:' : 'ws:';

  const ws = new WebSocket(wsUrl);
  const pending = new Map();
  let nextId = 1;

  const call = (type, data = {}) => new Promise((res, rej) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, type, ...data }));
  });

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'auth_required') {
      ws.send(JSON.stringify({ type: 'auth', access_token: token }));
    } else if (msg.type === 'auth_ok') {
      resolve({ call, close: () => ws.close() });
    } else if (msg.type === 'auth_invalid') {
      reject(new UserError('Home Assistant rejected the token on the WebSocket API, check the long lived token'));
      ws.close();
    } else if (msg.type === 'result' && pending.has(msg.id)) {
      const { res, rej } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.success) {
        res(msg.result);
      } else {
        rej(Object.assign(new Error(msg.error.message), { code: msg.error.code }));
      }
    }
  };
  ws.onerror = () => {
    reject(new UserError(`Could not connect to the Home Assistant WebSocket API at ${wsUrl}`));
  };
  ws.onclose = () => {
    reject(new UserError('Home Assistant closed the WebSocket connection'));
    pending.forEach(({ rej }) => rej(new UserError('Home Assistant closed the WebSocket connection')));
    pending.clear();
  };
});

// the config of every dashboard, auto generated dashboards have none and are skipped
const fetchDashboards = async (ha) => {
  const dashboards = [{ url_path: null, title: 'Overview (default)', mode: 'storage' }];
  dashboards.push(...await ha.call('lovelace/dashboards/list'));

  const result = [];
  await Promise.all(dashboards.map(async (dashboard) => {
    try {
      const config = await ha.call('lovelace/config', { url_path: dashboard.url_path });
      result.push({ ...dashboard, config });
    } catch (err) {
      if (err.code !== 'config_not_found') {
        console.warn(chalk.yellow(`Could not read dashboard ${dashboard.title}: ${err.message}`));
      }
    }
  }));
  return result;
};

// all floorplan cards in a dashboard config, wherever they are nested
// (views, sections, stacks, conditional cards...), with a readable location
const findFloorplanCards = (node, location, found = []) => {
  if (Array.isArray(node)) {
    node.forEach((child, i) => findFloorplanCards(child, `${location}[${i}]`, found));
  } else if (node && typeof node === 'object') {
    if (node.type === FLOORPLAN_CARD_TYPE) {
      found.push({ card: node, location });
    }
    Object.entries(node).forEach(([key, child]) => {
      const name = key === 'views' || key === 'sections' || key === 'cards' || key === 'card'
        ? `${location} > ${key}`
        : `${location}.${key}`;
      if (child && typeof child === 'object') {
        findFloorplanCards(child, name, found);
      }
    });
  }
  return found;
};

// the location of the card's image, the image can be a url or { location, cache }
const cardImageLocation = (card) => {
  const { image } = card.config;
  return image && typeof image === 'object' ? image.location : image;
};

// the file name of an image location, for an SVG embedded by exportboundary.js
// the name it is given in the data url (data:image/svg+xml;name=house.svg;base64,...)
const imageFileName = (location) => {
  if (typeof location !== 'string') {
    return null;
  }
  if (location.startsWith('data:')) {
    const name = location.slice(0, location.indexOf(',')).match(/;name=([^;,]+)/);
    return name ? decodeURIComponent(name[1]) : null;
  }
  return path.basename(location.split('?')[0]);
};

// a short description of an image location, embedded images can be very long
const describeImage = (location) => (typeof location === 'string' && location.startsWith('data:')
  ? `embedded ${imageFileName(location) || 'image'}`
  : location);

// the floorplan card to update: the one showing the SVG file, or the only one
const selectFloorplanCard = (cards, svgFileName) => {
  const svgName = path.basename(svgFileName);
  const showingSvg = cards.filter(({ card }) => card.config && typeof card.config === 'object'
    && imageFileName(cardImageLocation(card)) === svgName);

  if (showingSvg.length === 1) {
    return showingSvg[0];
  }
  if (showingSvg.length === 0 && cards.length === 1) {
    return cards[0];
  }
  const describe = (list) => list
    .map(({ dashboard, location, card }) => `  ${dashboard.title}: ${location} (image: ${
      card.config && typeof card.config === 'object' ? describeImage(cardImageLocation(card)) : card.config})`)
    .join('\n');
  if (showingSvg.length > 1) {
    throw new UserError(`More than one floorplan card shows ${svgName}, not updating any:\n${describe(showingSvg)}`);
  }
  throw new UserError(`No floorplan card shows ${svgName}, not updating any. Found:\n${describe(cards)}`);
};

// change the dashboard's floorplan card showing svgFileName (or the only one):
// question(cardConfig) is asked before update(cardConfig) changes it, and the
// dashboard config is backed up first. manualHint says how to do it by hand
// when the card can't be changed through the API
const updateFloorplanCard = async (baseUrl, token, svgFileName, {
  question, update, manualHint,
}) => {
  console.log('Searching Home Assistant dashboards for floorplan cards');
  const ha = await connectWebSocket(baseUrl, token);
  try {
    const dashboards = await fetchDashboards(ha);
    const cards = dashboards.flatMap((d) => findFloorplanCards(d.config, d.title)
      .map((found) => ({ ...found, dashboard: d })));
    if (cards.length === 0) {
      throw new UserError(`No ${FLOORPLAN_CARD_TYPE} found in any dashboard`);
    }
    console.info(`Found ${cards.length} floorplan card(s)`);

    const { card, dashboard, location } = selectFloorplanCard(cards, svgFileName);
    if (!card.config || typeof card.config !== 'object') {
      throw new UserError(`The floorplan card at ${location} keeps its config in a separate file (${card.config}), ${manualHint}`);
    }
    if (dashboard.mode === 'yaml') {
      throw new UserError(`Dashboard ${dashboard.title} is in YAML mode and can't be changed from here, ${manualHint}`);
    }

    console.info(`Floorplan card: ${location} (image: ${describeImage(cardImageLocation(card))})`);
    if (!confirm(question(card.config))) {
      console.info('Floorplan card not updated');
      return;
    }

    const backupFileName = path.join(
      __dirname,
      `lovelace_${dashboard.url_path || 'default'}.${randomString(6)}.bak.json`,
    );
    fs.writeFileSync(backupFileName, JSON.stringify(dashboard.config, null, 2));

    // the card object is part of dashboard.config, so this updates the whole config
    update(card.config);
    await ha.call('lovelace/config/save', { url_path: dashboard.url_path, config: dashboard.config });
    console.info(chalk.green(`Floorplan card updated, previous dashboard config saved as ${backupFileName}`));
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`Could not update the floorplan card: ${err.message}`);
  } finally {
    ha.close();
  }
};

module.exports = {
  FLOORPLAN_CARD_TYPE,
  namespaces,
  UserError,
  randomString,
  confirm,
  readSvg,
  parseServerUrl,
  fetchEntities,
  updateFloorplanCard,
};
