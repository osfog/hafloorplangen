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
const { XMLSerializer } = require('@xmldom/xmldom');
const xpath = require('xpath');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const {
  namespaces, UserError, randomString, confirm, readSvg,
  parseServerUrl, fetchEntities, updateFloorplanCard,
} = require('./common');

const header = `
_____  _____  _____  _                 _____  _            _____
|  |  ||  _  ||   __|| | ___  ___  ___ |  _  || | ___  ___ |   __| ___  ___
|     ||     ||   __|| || . || . ||  _||   __|| || .'||   ||  |  || -_||   |
|__|__||__|__||__|   |_||___||___||_|  |__|   |_||__,||_|_||_____||___||_|_|
`;

// generated rules are written next to this script
const RULES_OUTPUT_FILE = path.join(__dirname, 'ha_rules.yml');

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
    await updateFloorplanCard(baseUrl, options.token, svgFileName, {
      question: (cardConfig) => `Replace its ${Array.isArray(cardConfig.rules) ? cardConfig.rules.length : 0} rule(s) with the ${haFloorplanRules.length} generated rule(s)?`,
      update: (cardConfig) => { Object.assign(cardConfig, { rules: haFloorplanRules }); },
      manualHint: `update it with ${RULES_OUTPUT_FILE} by hand`,
    });
  }
  return 0;
};

main()
  .then((code) => { process.exitCode = code; })
  .catch((err) => {
    console.error(chalk.red(err instanceof UserError ? err.message : err.stack));
    process.exitCode = 1;
  });
