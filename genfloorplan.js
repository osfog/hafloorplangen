/* eslint-disable no-restricted-syntax */
/* eslint-disable no-loop-func */
/* eslint-disable no-console */
const chalk = require('chalk');
const url = require('node:url');
const https = require('https');
const http = require('http');
const fs = require('fs');
const yaml = require('js-yaml');
const libxml = require('libxmljs2');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');

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

let allSet = (cmdOptions == true);

if (cmdOptions && cmdOptions.svg && cmdOptions.rules && cmdOptions.url && cmdOptions.token) {
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
  const xmlFile = fs.readFileSync(svgFileName, 'utf8');
  const svgDoc = libxml.parseXmlString(xmlFile);

  // read rules file
  const rulesFile = fs.readFileSync(cmdOptions.rules[0], 'utf8');
  let rules = null;
  // validate yaml
  try {
    rules = yaml.load(rulesFile);
  } catch (err) {
    console.error(`Error in rules: ${err.message}`);
  }

  const q = url.parse(cmdOptions.url, true);
  // test if the url is valid
  if (!q.hostname) {
    console.error('Invalid URL');
  }

  // test if the protocol is http or https
  if (q.protocol !== 'http:' && q.protocol !== 'https:') {
    console.error('Invalid protocol');
  }


  const protocol = q.protocol === 'http:' ? http : https;
  const requestOptions = {
    path: '/api/states',
    host: q.hostname,
    port: q.port,
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
      entities = JSON.parse(data);
      const entityIDs = entities.map((e) => e.entity_id);

      console.info(`Received: ${entities.length} entities`);

      // iterate the types that there we want rules for

      for (const rule of rules) {
        const svgPrimitive = rule.svg_primitive || rule.type;
        let layerSVGElement = svgDoc.get(
          `//*[@inkscape:label='${svgPrimitive}']`,
          namespaces,
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
          console.info(`Layer ${rule.type} does not exist - creating it`);
          layerSVGElement = svgDoc.root().node('g');
          layerSVGElement.attr({
            'inkscape:groupmode': 'layer',
            id: `layer_${svgPrimitive}`,
            'inkscape:label': svgPrimitive,
          });
        }

        // filter entities
        let ruleEntities = entityIDs.filter((e) => e.split('.')[0] === rule.type);

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

        console.info(
          `Found ${ruleEntities.length} entities of type ${rule.type
          }, attribute ${rule.attribute ? JSON.stringify(rule.attribute) : '<none>'
          }, friendly_name_includes: ${rule.friendly_name_includes
            ? rule.friendly_name_includes
            : '<none>'
          }`,
        );

        // Generate the rule part
        rule.rules.entities = ruleEntities;
        haFloorplanRules.push(rule.rules);

        let svgSnippets = svgDoc.find(
          `//*[@inkscape:label='floorplan.${svgPrimitive}']`,
          namespaces,
        );

        if (!svgSnippets || svgSnippets.length === 0) {
          svgSnippets = svgDoc.find(
            `//*[@id='floorplan.${svgPrimitive}']`,
            namespaces,
          );
        }

        if (svgSnippets.length > 1) {
          console.warn('More than one svg snippet found');
        }
        if (svgSnippets.length === 0) {
          console.error(`No svg snippet for ${rule.type} found`);
        }

        const svgSnippet = svgSnippets[0];
        // Generate the svg part
        ruleEntities.forEach((e) => {
          if (!svgDoc.get(`//*[@id='${e}']`)) {
            layerSVGElement.addChild(
              svgSnippet.clone().attr({ id: e, 'inkscape:label': e }),
            );
            console.info(`Entity ${e} has been added to SVG`);
          } else {
            console.info(`Entity ${e} already exists in SVG`);
          }
        });
      }
      fs.writeFileSync(svgFileName, svgDoc.toString());
      fs.writeFileSync(
        `${__dirname}/ha_rules.yml`,
        yaml.dump(haFloorplanRules, { lineWidth: 1000 }),
      );
    });
  });

  req.end();

  req.on('error', (e) => {
    console.error(
      'Failed to get entities - please ensure that Home Assistant server is available and that the long lived token is correct.', e);
  });
}
