/* eslint-disable no-restricted-syntax */
/* eslint-disable no-loop-func */
/* eslint-disable no-console */
const chalk = require('chalk');
const https = require('https');
const http = require('http');
const fs = require('fs');
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

const namespaces = {
  inkscape: 'http://www.inkscape.org/namespaces/inkscape',
  sodipodi: 'http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd',
  svg: 'http://www.w3.org/2000/svg',
  hafloorplan: 'http://www.example.com/hafloorplan',
};

const select = xpath.useNamespaces(namespaces);

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

const optionDefinitions = [
  {
    name: 'svg',
    alias: 's',
    type: String,
    multiple: true,
    description: 'The svg floorplan file to process',
    typeLabel: '<file>',
    required: true,
  },
  {
    name: 'rules',
    alias: 'r',
    type: String,
    multiple: true,
    description: 'The HA Floorplan rules to base from',
    typeLabel: '<file>',
    required: true,
  },
  {
    name: 'url',
    alias: 'u',
    type: String,
    description: 'The url to the Home Assistant server',
    typeLabel: '<url>',
    required: true,
  },
  {
    name: 'token',
    alias: 't',
    type: String,
    description: 'Long lived token to the Home Assistant server',
    typeLabel: '<token>',
    required: true,
  },
  // {
  //   name: "log",
  //   alias: "l",
  //   type: String,
  //   description: "info, warn or error",
  // },
];

/** ************** Function declarations *********************** */

// generate a 8 character random string
const randomString = (length) => {
  let result = '';
  const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'; // 62 characters
  const charactersLength = characters.length;
  for (let i = 0; i < length; i += 1) {
    result += characters.charAt(Math.random() * charactersLength);
  } // end for
  return result;
}; // end randomString

let cmdOptions;
try {
  cmdOptions = commandLineArgs(optionDefinitions);
} catch {
  // noop
}

let allSet = false;

if (
  cmdOptions
  && cmdOptions.svg
  && cmdOptions.rules
  && cmdOptions.url
  && cmdOptions.token
) {
  allSet = true;
} else {
  console.log(chalk.red('All command line options are required.'));
}

if (!allSet || cmdOptions.help) {
  const usage = commandLineUsage([
    {
      content: chalk.blue(header),
      raw: true,
    },
    {
      header: 'Generator for HA Floorplan',
      content: `A simple application to add entities to SVG and collect for rules.
        
        - All command line options are required.
        
        - Example SVG and rule fines are available in the examples folder.

        - The SVG file will be backed up before processing. 

        - The rules file is a yaml file that contains the rules for the entities to be added to the SVG.
          Created rules to be included in the HA Floorplan configuration are stored a ha_rules.yml file 
          in the working directory.
        `,
    },
    {
      header: 'Required parameters',
      optionList: optionDefinitions,
    },
    {
      content:
        'Project home: {underline https://github.com/osfog/hafloorplangen}',
    },
  ]);
  console.log(usage);
} else {
  const svgFileName = cmdOptions.svg[0];
  console.log(`Using: ${svgFileName} as SVG reference`);

  // copy file to backup
  fs.copyFileSync(svgFileName, `${svgFileName}.${randomString(6)}.bak`);

  // read svg file
  let xmlFile = fs.readFileSync(svgFileName, 'utf8');
  // declare the hafloorplan namespace on the root, files written by earlier
  // versions used the prefix without declaring it which fails to parse
  if (!xmlFile.includes('xmlns:hafloorplan=')) {
    xmlFile = xmlFile.replace(
      /<svg(\s|>)/,
      `<svg xmlns:hafloorplan="${namespaces.hafloorplan}"$1`,
    );
  }
  const svgDoc = new DOMParser().parseFromString(xmlFile, 'text/xml');

  // read rules file
  const rulesFile = fs.readFileSync(cmdOptions.rules[0], 'utf8');
  let rules = null;
  // validate yaml
  try {
    rules = yaml.load(rulesFile);
  } catch (err) {
    console.error(`Error in rules: ${err.message}`);
  }

  let q;
  // test if the url is valid
  try {
    q = new URL(cmdOptions.url);
  } catch {
    console.error(`Invalid URL: ${cmdOptions.url}`);
    process.exit(1);
  }

  // test if the protocol is http or https
  if (q.protocol !== 'http:' && q.protocol !== 'https:') {
    console.error(`Invalid protocol: ${q.protocol}`);
    process.exit(1);
  }

  const protocol = q.protocol === 'http:' ? http : https;
  const requestOptions = {
    path: '/api/states',
    host: q.hostname,
    port: q.port || undefined,
    method: 'GET',
    headers: {
      Authorization: `Bearer ${cmdOptions.token}`,
    },
  };

  let entities = [];
  let data = '';
  const haFloorplanRules = [];
  const req = protocol.request(requestOptions, (resp) => {
    console.log('Fetching entities from Home Assistant');
    // A chunk of data has been received.
    resp.on('data', (chunk) => {
      data += chunk;
    });

    // The whole response has been received
    resp.on('end', () => {
      try {
        entities = JSON.parse(data);
      } catch (err) {
        console.error(
          'Error parsing JSON from Home Assistant. Ensure url and token are correct:',
          err.message,
        );
        return;
      }
      const entityIDs = entities.map((e) => e.entity_id);

      console.info(`Received: ${entities.length} entities`);

      // iterate the types that there we want rules for
      let handledEntities = [];

      for (const rule of rules) {
        const svgPrimitive = rule.svg_primitive || rule.type;
        let layerSVGElement = select(
          `//*[@inkscape:label='${svgPrimitive}']`,
          svgDoc,
          true,
        );

        // validate yaml
        try {
          yaml.load(rule.rule_snippet);
        } catch (err) {
          console.error(
            `Error in rule snippet for ${rule.type}: ${err.message}`,
          );
        }

        if (!layerSVGElement) {
          console.info(`Layer ${svgPrimitive} does not exist - creating it`);
          layerSVGElement = svgDoc.documentElement.appendChild(
            svgDoc.createElementNS(namespaces.svg, 'g'),
          );
          setAttributes(layerSVGElement, {
            'inkscape:groupmode': 'layer',
            id: `layer_${svgPrimitive}`,
            'inkscape:label': svgPrimitive,
          });
        }
        let ruleEntities = [];

        // filter entities
        if (rule.entity_id) {
          if (!entityIDs.includes(rule.entity_id)) {
            console.warn(
              `Entity ${rule.entity_id} not found in Home Assistant`,
            );
          } else {
            ruleEntities = [rule.entity_id];
          }
        } else {
          ruleEntities = entityIDs.filter(
            (e) => e.split('.')[0] === rule.type,
          );

          // filter by attribute
          if (rule.attribute) {
            ruleEntities = ruleEntities.filter(
              (e) => entities.find((ee) => ee.entity_id === e).attributes
                .device_class === rule.attribute.device_class,
            );
          }

          // filter by friendly name
          if (rule.friendly_name_includes) {
            ruleEntities = ruleEntities.filter((e) => entities
              .find((ee) => ee.entity_id === e)
              .attributes.friendly_name.toLowerCase()
              .includes(rule.friendly_name_includes));
          }

          // filter by entity name includes
          if (rule.entity_id_includes) {
            ruleEntities = ruleEntities.filter((e) => entities
              .find((ee) => ee.entity_id === e)
              .entity_id.toLowerCase()
              .includes(rule.entity_id_includes));
          }

          console.info(
            `Found ${ruleEntities.length} entities of type ${
              rule.type
            }, attribute ${
              rule.attribute ? JSON.stringify(rule.attribute) : '<none>'
            }, friendly_name_includes: ${
              rule.friendly_name_includes
                ? rule.friendly_name_includes
                : '<none>'
            },entity_id includes: ${
              rule.entity_id_includes
                ? rule.entity_id_includes
                : '<none>'
            }`,
          );
        }

        // filter already handled entities
        ruleEntities = ruleEntities.filter((e) => !handledEntities.includes(e));

        // add the found entities to a list to ensure they are included just once
        handledEntities = handledEntities.concat(ruleEntities);

        // Generate the rule part
        rule.rules.entities = ruleEntities;
        haFloorplanRules.push(rule.rules);

        let svgSnippets = select(
          `//*[@inkscape:label='floorplan.${svgPrimitive}']`,
          svgDoc,
        );

        if (!svgSnippets || svgSnippets.length === 0) {
          svgSnippets = select(
            `//*[@id='floorplan.${svgPrimitive}']`,
            svgDoc,
          );
        }

        if (svgSnippets.length > 1) {
          console.warn('More than one svg snippet found');
        }
        if (svgSnippets.length === 0) {
          console.error(
            `No svg snippet for ${rule.type} found (expected an element with inkscape:label or id 'floorplan.${svgPrimitive}') - not adding its entities to the SVG`,
          );
        }

        const svgSnippet = svgSnippets[0];
        // Generate the svg part
        ruleEntities.forEach((e) => {
          if (!svgSnippet) return;
          if (!select(`//*[@id='${e}']`, svgDoc, true)) {
            layerSVGElement.appendChild(
              setAttributes(svgSnippet.cloneNode(true), {
                id: e,
                'inkscape:label': e,
                'hafloorplan:entity': e,
              }),
            );
            console.info(`Entity ${e} has been added to SVG`);
          } else {
            // console.info(`Entity ${e} already exists in SVG`);
          }
        });
      }

      // go through svg snippets not in the entities and warn
      const existingEntitiesInSVG = select(
        '//*[@hafloorplan:entity]',
        svgDoc,
      );
      if (existingEntitiesInSVG) {
        existingEntitiesInSVG.forEach((el) => {
          const entityID = el.getAttributeNS(namespaces.hafloorplan, 'entity');
          if (!entityIDs.includes(entityID)) {
            console.info(
              `Entity ${entityID} in SVG no longer in Home Assistant do you want to remove it?`,
            );
            try {
              const cmd = `sh -c 'read -p "Remove entity ${entityID} from SVG? (y/N): " ans; echo "$ans"'`;
              const answer = execSync(cmd, { stdio: ['inherit', 'pipe', 'inherit'] })
                .toString()
                .trim()
                .toLowerCase();
              if (answer === 'y' || answer === 'yes') {
                try {
                  el.parentNode.removeChild(el);
                  console.info(`Entity ${entityID} removed from SVG`);
                } catch (removeErr) {
                  console.error(`Failed to remove ${entityID}:`, removeErr.message);
                }
              }
            } catch (err) {
              console.error('Interactive prompt failed (possibly non-Unix shell); skipping removal.');
            }
          }
        });
      }

      // rules file name
      const rulesFileName = `${__dirname}/ha_rules.yml`;

      fs.writeFileSync(svgFileName, new XMLSerializer().serializeToString(svgDoc));
      fs.writeFileSync(
        rulesFileName,
        yaml.dump(haFloorplanRules, { lineWidth: 1000 }),
      );

      // Reopen the SVG and replace occurrences of "\{" with "{"
      try {
        const rulesContent = fs.readFileSync(rulesFileName, 'utf8');
        const updatedContent = rulesContent.replace(/\\\${/g, '${');
        if (updatedContent !== rulesContent) {
          fs.writeFileSync(rulesFileName, updatedContent, 'utf8');
          console.info('Replaced "\\${" with "${" in rules file');
        } else {
          console.info('No "\\${" sequences found in rules file');
        }
      } catch (err) {
        console.error('Error reopening or modifying rules file:', err.message);
      }
    });
  });

  req.end();

  req.on('error', (e) => {
    console.error(
      'Failed to get entities - please ensure that Home Assistant server is available and that the long lived token is correct.',
      e,
    );
  });
}
