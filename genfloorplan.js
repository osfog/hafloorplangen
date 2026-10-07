#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * HA Floorplan Generator
 *
 * Populates a Home Assistant floorplan SVG with one symbol per matching
 * entity and generates the matching ha-floorplan rules.
 *
 * For each rule in the rules file:
 *  1. Entities are selected from Home Assistant, either a single entity_id or
 *     all entities of a domain (type) narrowed by optional filters.
 *  2. The template element 'floorplan.<svg_primitive>' is cloned into the
 *     layer labelled '<svg_primitive>' for every entity not already in the SVG.
 *  3. The rule's 'rules' block, with the matched entities, is added to
 *     ha_rules.yml for pasting into the ha-floorplan configuration.
 *
 * With --card the generated rules are also written straight into the
 * floorplan card of a Home Assistant dashboard, over the WebSocket API.
 *
 * See README.md for the rules file format.
 */
const chalk = require('chalk');
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const xpath = require('xpath');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const { execSync } = require('child_process');

const header = `
_____  _____  _____  _                 _____  _            _____
|  |  ||  _  ||   __|| | ___  ___  ___ |  _  || | ___  ___ |   __| ___  ___
|     ||     ||   __|| || . || . ||  _||   __|| || .'||   ||  |  || -_||   |
|__|__||__|__||__|   |_||___||___||_|  |__|   |_||__,||_|_||_____||___||_|_|
`;

// generated rules are written next to this script
const RULES_OUTPUT_FILE = path.join(__dirname, 'ha_rules.yml');

const FLOORPLAN_CARD_TYPE = 'custom:floorplan-card';

const namespaces = {
  inkscape: 'http://www.inkscape.org/namespaces/inkscape',
  sodipodi: 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
  svg: 'http://www.w3.org/2000/svg',
  // marks elements created by this tool, used to find entities removed from HA
  hafloorplan: 'http://www.example.com/hafloorplan',
};

const select = xpath.useNamespaces(namespaces);

const optionDefinitions = [
  {
    name: 'svg',
    alias: 's',
    type: String,
    description: 'The SVG floorplan file to update',
    typeLabel: '<file>',
  },
  {
    name: 'rules',
    alias: 'r',
    type: String,
    description: 'The rules file describing which entities to add',
    typeLabel: '<file>',
  },
  {
    name: 'url',
    alias: 'u',
    type: String,
    description: 'The url to the Home Assistant server, e.g. http://homeassistant.local:8123',
    typeLabel: '<url>',
  },
  {
    name: 'token',
    alias: 't',
    type: String,
    description: 'Long lived access token for the Home Assistant server',
    typeLabel: '<token>',
  },
  {
    name: 'card',
    alias: 'c',
    type: Boolean,
    description: 'Also write the generated rules into the floorplan card of the Home Assistant dashboard',
  },
  {
    name: 'help',
    alias: 'h',
    type: Boolean,
    description: 'Show this help',
  },
];
const requiredOptions = ['svg', 'rules', 'url', 'token'];

/** ************** Helpers *********************** */

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

// set attributes, resolving prefixed names (e.g. inkscape:label) to their namespace
const setAttributes = (el, attrs) => {
  Object.entries(attrs).forEach(([name, value]) => {
    const prefix = name.includes(':') ? name.split(':')[0] : null;
    if (prefix && namespaces[prefix]) {
      el.setAttributeNS(namespaces[prefix], name, value);
    } else {
      el.setAttribute(name, value);
    }
  });
  return el;
};

// replace \${ with ${ in every string, rules may escape ha-floorplan templates
const unescapeTemplates = (value) => {
  if (typeof value === 'string') {
    return value.replace(/\\\$\{/g, '${');
  }
  if (Array.isArray(value)) {
    return value.map(unescapeTemplates);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, unescapeTemplates(v)]));
  }
  return value;
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

const printUsage = () => {
  console.log(commandLineUsage([
    {
      content: chalk.blue(header),
      raw: true,
    },
    {
      header: 'Generator for HA Floorplan',
      content: `Adds a symbol to the SVG for each Home Assistant entity matching the rules,
        and generates the corresponding ha-floorplan rules.

        - All options except --card and --help are required.

        - Example SVG and rules files are available in the example folder.

        - The SVG file is backed up (<file>.<random>.bak) before it is changed.

        - Generated rules, to be included in the ha-floorplan configuration, are
          written to ha_rules.yml in the application folder.

        - With --card the rules also replace the rules of the floorplan card in
          the Home Assistant dashboard, after confirmation. The dashboard config
          is backed up (lovelace_<dashboard>.<random>.bak.json) first.
        `,
    },
    {
      header: 'Options',
      optionList: optionDefinitions,
    },
    {
      header: 'Example',
      content: 'node genfloorplan.js -s example/planer.svg -r example/rules.yml -u http://homeassistant.local:8123 -t <token>',
    },
    {
      content:
        'Project home: {underline https://github.com/osfog/hafloorplangen}',
    },
  ]));
};

/** ************** Input *********************** */

// returns the parsed command line options, or null if they are invalid
const parseCommandLine = () => {
  let options;
  try {
    options = commandLineArgs(optionDefinitions);
  } catch (err) {
    console.log(chalk.red(err.message));
    return null;
  }
  if (options.help) {
    return options;
  }
  const missing = requiredOptions.filter((name) => !options[name]);
  if (missing.length > 0) {
    console.log(chalk.red(`Missing required options: ${missing.map((m) => `--${m}`).join(', ')}`));
    return null;
  }
  return options;
};

// read and validate the rules file, see README.md for the format
const readRules = (fileName) => {
  let rules;
  try {
    rules = yaml.load(fs.readFileSync(fileName, 'utf8'));
  } catch (err) {
    throw new UserError(`Could not read rules file ${fileName}: ${err.message}`);
  }
  if (!Array.isArray(rules)) {
    throw new UserError(`Rules file ${fileName} must contain a list of rules`);
  }

  const errors = [];
  rules.forEach((rule, i) => {
    const name = `Rule ${i + 1}${rule && rule.type ? ` (${rule.type})` : ''}`;
    if (!rule || typeof rule !== 'object') {
      errors.push(`${name} is not an object`);
      return;
    }
    if (!rule.entity_id && !rule.type) {
      errors.push(`${name} needs either entity_id or type`);
    }
    if (!rule.svg_primitive && !rule.type) {
      errors.push(`${name} needs either svg_primitive or type`);
    }
    if (!rule.rules || typeof rule.rules !== 'object') {
      errors.push(`${name} has no 'rules' block`);
    }
  });
  if (errors.length > 0) {
    throw new UserError(`Errors in rules file ${fileName}:\n  ${errors.join('\n  ')}`);
  }
  return rules;
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

// the floorplan card to update: the one showing the SVG file, or the only one
const selectFloorplanCard = (cards, svgFileName) => {
  const svgName = path.basename(svgFileName);
  const showingSvg = cards.filter(({ card }) => card.config && typeof card.config === 'object'
    && typeof card.config.image === 'string'
    && path.basename(card.config.image.split('?')[0]) === svgName);

  if (showingSvg.length === 1) {
    return showingSvg[0];
  }
  if (showingSvg.length === 0 && cards.length === 1) {
    return cards[0];
  }
  const describe = (list) => list
    .map(({ dashboard, location, card }) => `  ${dashboard.title}: ${location} (image: ${card.config && card.config.image})`)
    .join('\n');
  if (showingSvg.length > 1) {
    throw new UserError(`More than one floorplan card shows ${svgName}, not updating any:\n${describe(showingSvg)}`);
  }
  throw new UserError(`No floorplan card shows ${svgName}, not updating any. Found:\n${describe(cards)}`);
};

// replace the rules of the dashboard's floorplan card with the generated rules
const updateFloorplanCard = async (baseUrl, token, svgFileName, haFloorplanRules) => {
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
      throw new UserError(`The floorplan card at ${location} keeps its config in a separate file (${card.config}), update it with ${RULES_OUTPUT_FILE} by hand`);
    }
    if (dashboard.mode === 'yaml') {
      throw new UserError(`Dashboard ${dashboard.title} is in YAML mode and can't be changed from here, update it with ${RULES_OUTPUT_FILE} by hand`);
    }

    const oldCount = Array.isArray(card.config.rules) ? card.config.rules.length : 0;
    console.info(`Floorplan card: ${location} (image: ${card.config.image})`);
    if (!confirm(`Replace its ${oldCount} rule(s) with the ${haFloorplanRules.length} generated rule(s)?`)) {
      console.info('Floorplan card not updated');
      return;
    }

    const backupFileName = path.join(
      __dirname,
      `lovelace_${dashboard.url_path || 'default'}.${randomString(6)}.bak.json`,
    );
    fs.writeFileSync(backupFileName, JSON.stringify(dashboard.config, null, 2));

    // the card object is part of dashboard.config, so this updates the whole config
    card.config.rules = haFloorplanRules;
    await ha.call('lovelace/config/save', { url_path: dashboard.url_path, config: dashboard.config });
    console.info(chalk.green(`Floorplan card updated, previous dashboard config saved as ${backupFileName}`));
  } catch (err) {
    if (err instanceof UserError) throw err;
    throw new UserError(`Could not update the floorplan card: ${err.message}`);
  } finally {
    ha.close();
  }
};

/** ************** Processing *********************** */

const describeRule = (rule) => {
  if (rule.entity_id) {
    return `entity_id: ${rule.entity_id}`;
  }
  const filters = [`type: ${rule.type}`];
  if (rule.attribute) filters.push(`attribute: ${JSON.stringify(rule.attribute)}`);
  if (rule.friendly_name_includes) filters.push(`friendly_name_includes: ${rule.friendly_name_includes}`);
  if (rule.entity_id_includes) filters.push(`entity_id_includes: ${rule.entity_id_includes}`);
  return filters.join(', ');
};

// returns the ids of the entities matching the rule
const matchEntities = (rule, entities) => {
  if (rule.entity_id) {
    if (!entities.some((e) => e.entity_id === rule.entity_id)) {
      console.warn(chalk.yellow(`Entity ${rule.entity_id} not found in Home Assistant`));
      return [];
    }
    return [rule.entity_id];
  }

  let matches = entities.filter((e) => e.entity_id.split('.')[0] === rule.type);

  // every listed attribute must equal the entity's attribute
  if (rule.attribute) {
    matches = matches.filter((e) => Object.entries(rule.attribute)
      .every(([key, value]) => (e.attributes || {})[key] === value));
  }

  if (rule.friendly_name_includes) {
    const needle = String(rule.friendly_name_includes).toLowerCase();
    matches = matches.filter((e) => String((e.attributes || {}).friendly_name || '')
      .toLowerCase()
      .includes(needle));
  }

  if (rule.entity_id_includes) {
    const needle = String(rule.entity_id_includes).toLowerCase();
    matches = matches.filter((e) => e.entity_id.toLowerCase().includes(needle));
  }

  return matches.map((e) => e.entity_id);
};

// the layer labelled svgPrimitive, created at the top of the drawing if missing
const findOrCreateLayer = (svgDoc, svgPrimitive) => {
  const layer = select(`//*[@inkscape:label='${svgPrimitive}']`, svgDoc, true);
  if (layer) {
    return layer;
  }
  console.info(`Layer ${svgPrimitive} does not exist - creating it`);
  return setAttributes(
    svgDoc.documentElement.appendChild(svgDoc.createElementNS(namespaces.svg, 'g')),
    {
      'inkscape:groupmode': 'layer',
      id: `layer_${svgPrimitive}`,
      'inkscape:label': svgPrimitive,
    },
  );
};

// the template element for svgPrimitive, matched by label first and then by id
const findSnippet = (svgDoc, svgPrimitive) => {
  let snippets = select(`//*[@inkscape:label='floorplan.${svgPrimitive}']`, svgDoc);
  if (snippets.length === 0) {
    snippets = select(`//*[@id='floorplan.${svgPrimitive}']`, svgDoc);
  }
  if (snippets.length > 1) {
    console.warn(chalk.yellow(`More than one svg snippet found for floorplan.${svgPrimitive}, using the first`));
  }
  return snippets[0];
};

// clone the snippet into the layer for each entity not already in the SVG,
// returns the number of entities added
const addEntitiesToSvg = (svgDoc, svgPrimitive, entityIDs) => {
  const missing = entityIDs.filter((e) => !select(`//*[@id='${e}']`, svgDoc, true));
  if (missing.length === 0) {
    return 0;
  }

  const snippet = findSnippet(svgDoc, svgPrimitive);
  if (!snippet) {
    console.error(chalk.red(
      `No svg snippet found (expected an element with inkscape:label or id 'floorplan.${svgPrimitive}') - not adding ${missing.join(', ')} to the SVG`,
    ));
    return 0;
  }

  const layer = findOrCreateLayer(svgDoc, svgPrimitive);
  missing.forEach((e) => {
    layer.appendChild(setAttributes(snippet.cloneNode(true), {
      id: e,
      'inkscape:label': e,
      'hafloorplan:entity': e,
    }));
    console.info(chalk.green(`Entity ${e} has been added to SVG`));
  });
  return missing.length;
};

// offer to remove symbols added by this tool whose entity no longer exists,
// returns the number of entities removed
const removeStaleEntities = (svgDoc, entityIDs) => {
  let removed = 0;
  select('//*[@hafloorplan:entity]', svgDoc).forEach((el) => {
    const entityID = el.getAttributeNS(namespaces.hafloorplan, 'entity');
    if (entityIDs.has(entityID)) {
      return;
    }
    console.warn(chalk.yellow(`Entity ${entityID} is in the SVG but no longer in Home Assistant`));
    if (confirm(`Remove entity ${entityID} from SVG?`)) {
      el.parentNode.removeChild(el);
      removed += 1;
      console.info(`Entity ${entityID} removed from SVG`);
    }
  });
  return removed;
};

/** ************** Main *********************** */

const main = async () => {
  const options = parseCommandLine();
  if (!options || options.help) {
    printUsage();
    return options ? 0 : 1;
  }

  const svgFileName = options.svg;
  console.log(`Using: ${svgFileName} as SVG reference`);

  const rules = readRules(options.rules);
  const svgDoc = readSvg(svgFileName);
  const baseUrl = parseServerUrl(options.url);
  const entities = await fetchEntities(baseUrl, options.token);
  console.info(`Received: ${entities.length} entities`);

  // an entity is only included by the first rule matching it
  const handledEntities = new Set();
  const haFloorplanRules = [];
  let svgChanges = 0;

  rules.forEach((rule) => {
    const svgPrimitive = rule.svg_primitive || rule.type;
    const ruleEntities = matchEntities(rule, entities).filter((e) => !handledEntities.has(e));
    ruleEntities.forEach((e) => handledEntities.add(e));
    console.info(`Found ${ruleEntities.length} entities for ${describeRule(rule)}`);

    haFloorplanRules.push({ ...unescapeTemplates(rule.rules), entities: ruleEntities });
    svgChanges += addEntitiesToSvg(svgDoc, svgPrimitive, ruleEntities);
  });

  svgChanges += removeStaleEntities(svgDoc, new Set(entities.map((e) => e.entity_id)));

  if (svgChanges > 0) {
    const backupFileName = `${svgFileName}.${randomString(6)}.bak`;
    fs.copyFileSync(svgFileName, backupFileName);
    fs.writeFileSync(svgFileName, new XMLSerializer().serializeToString(svgDoc));
    console.info(`SVG updated with ${svgChanges} change(s), backup saved as ${backupFileName}`);
  } else {
    console.info('SVG already up to date, not modified');
  }

  fs.writeFileSync(RULES_OUTPUT_FILE, yaml.dump(haFloorplanRules, { lineWidth: 1000 }));
  console.info(`Rules written to ${RULES_OUTPUT_FILE}`);

  if (options.card) {
    await updateFloorplanCard(baseUrl, options.token, svgFileName, haFloorplanRules);
  }
  return 0;
};

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(chalk.red(err instanceof UserError ? err.message : err.stack));
    process.exitCode = 1;
  });
