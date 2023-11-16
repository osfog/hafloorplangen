const chalk = require('chalk');
const url = require("node:url");
const https = require("https");
const http = require("http");
const fs = require("fs");
const yaml = require("js-yaml");
const libxml = require("libxmljs2");
const commandLineArgs = require("command-line-args");
const commandLineUsage = require("command-line-usage");

const header =`                                                    
_____  _____  _____  _                 _____  _            _____           
|  |  ||  _  ||   __|| | ___  ___  ___ |  _  || | ___  ___ |   __| ___  ___ 
|     ||     ||   __|| || . || . ||  _||   __|| || .'||   ||  |  || -_||   |
|__|__||__|__||__|   |_||___||___||_|  |__|   |_||__,||_|_||_____||___||_|_|                                                                          
`

const namespaces = {
  inkscape: "http://www.inkscape.org/namespaces/inkscape",
  sodipodi: "http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd",
  svg: "http://www.w3.org/2000/svg",
};

const optionDefinitions = [
  {
    name: "svg",
    alias: "s",
    type: String,
    multiple: true,
    description: "The svg floorplan file to process",
    typeLabel: "<file>",
    required: true,
  },
  {
    name: "rules",
    alias: "r",
    type: String,
    multiple: true,
    description: "The HA Floorplan rules to base from",
    typeLabel: "<file>",
    required: true,
  },
  {
    name: "url",
    alias: "u",
    type: String,
    description: "The url to the Home Assistant server",
    typeLabel: "<url>",
    required: true,
  },
  {
    name: "token",
    alias: "t",
    type: String,
    description: "Long lived token to the Home Assistant server",
    typeLabel: "<token>",
    required: true,
  },
  // {
  //   name: "log",
  //   alias: "l",
  //   type: String,
  //   description: "info, warn or error",
  // },
];

/**************** Function declarations *********************** */

//generate a 8 character random string
const randomString = (length) => {
  let result = "";
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"; // 62 characters
  const charactersLength = characters.length;
  for (let i = 0; i < length; i++) {
    result += characters.charAt(Math.random() * charactersLength);
  } //end for
  return result;
}; //end randomString

let cmd_options ;
try {
cmd_options = commandLineArgs(optionDefinitions);
}
catch {


}

let all_set = (cmd_options==true);

if (cmd_options.svg && cmd_options.rules && cmd_options.url && cmd_options.token) {
  all_set = true;
}
else {
  console.log(chalk.red("All command line options are required."))
}


if (!all_set || cmd_options.help) {
  const usage = commandLineUsage([
    {
      content: chalk.blue(header),
      raw: true
    },
    {
      header: "Generator for HA Floorplan",
      content:
        `A simple application to add entities to SVG and collect for rules.
        
        - All command line options are required.
        
        - Example SVG and rule fines are available in the examples folder.

        - The SVG file will be backed up before processing. 

        - The rules file is a yaml file that contains the rules for the entities to be added to the SVG.
          Created rules are stored a ha_rules.yml file in the working directory.
        ` ,
    },
    {
      header: "Required parameters",
      optionList: optionDefinitions,
    },
    {
      content:
        "Project home: {underline https://github.com/osfog/hafloorplangen}",
    },
  ]);
  console.log(usage);


} else {
 

const svg_file_name = cmd_options.svg[0];
console.log(`Using: ${svg_file_name} as SVG reference`);

//copy file to backup
fs.copyFileSync(svg_file_name, svg_file_name + "." + randomString(6) + ".bak");

// read svg file
const xmlFile = fs.readFileSync(svg_file_name, "utf8");
let svgDoc = libxml.parseXmlString(xmlFile);

//read rules file
const rules_file = fs.readFileSync(cmd_options.rules[0], "utf8");
let rules = null;
//validate yaml
try {
  rules = yaml.load(rules_file);
} catch (err) {
  console.log(`Error in rules: ${err.message}`);
}

var q = url.parse(cmd_options.url, true);
var protocol = q.protocol == "http" ? http : https;
const request_options = {
  path: "/api/states",
  host: q.hostname,
  port: q.port,
  method: "GET",
  headers: {
    Authorization: "Bearer " + cmd_options.token,
  },
};

var entities = [];
let data = "";
let ha_floorplan_rules = [];
try {
  var req = protocol.request(request_options, function (resp) {
    console.log("Fetching entities from Home Assistant");
    // A chunk of data has been received.
    resp.on("data", (chunk) => {
      data += chunk;
    });

    // The whole response has been received
    resp.on("end", () => {
      entities = JSON.parse(data);
      entity_ids = entities.map((e) => e.entity_id);

      console.info(`Received: ${entities.length} entities`);

      //iterate the types that there we want rules for

      generated_elements = [];

      for (rule of rules) {
        svg_primitive = rule.svg_primitive || rule.type;
        layer_element = svgDoc.get(
          `//*[@inkscape:label='${svg_primitive}']`,
          namespaces
        );

        //validate yaml
        try {
          yaml.load(rule.rule_snippet);
        } catch (err) {
          console.error(
            `Error in rule snippet for ${rule.type}: ${err.message}`
          );
        }

        if (!layer_element) {
          console.info(`Layer ${rule.type} does not exist - creating it`);
          layer_element = svgDoc.root().node("g");
          layer_element.attr({
            "inkscape:groupmode": "layer",
            id: "layer_" + svg_primitive,
            "inkscape:label": svg_primitive,
          });
        }

        //filter entities
        rule_entities = entity_ids.filter((e) => e.split(".")[0] == rule.type);

        //filter by attribute
        if (rule.attribute) {
          rule_entities = rule_entities.filter(
            (e) =>
              entities.find((ee) => ee.entity_id == e).attributes
                .device_class == rule.attribute.device_class
          );
        }

        //filter by friendly name
        if (rule.friendly_name_includes) {
          rule_entities = rule_entities.filter((e) =>
            entities
              .find((ee) => ee.entity_id == e)
              .attributes.friendly_name.toLowerCase()
              .includes(rule.friendly_name_includes)
          );
        }

        console.info(
          `Found ${rule_entities.length} entities of type ${
            rule.type
          }, attribute ${
            rule.attribute ? JSON.stringify(rule.attribute) : "<none>"
          }, friendly_name_includes: ${
            rule.friendly_name_includes ? rule.friendly_name_includes : "<none>"
          }`
        );

        //Generate the rule part
        rule.rules.entities = rule_entities;
        ha_floorplan_rules.push(rule.rules);

        let svg_snippets = svgDoc.find(
          `//*[@inkscape:label='floorplan.${svg_primitive}']`,
          namespaces
        );

        if (!svg_snippets || svg_snippets.length == 0) {
          svg_snippets = svgDoc.find(
            `//*[@id='floorplan.${svg_primitive}']`,
            namespaces
          );
        }

        if (svg_snippets.length > 1) {
          console.warn("More than one svg snippet found");
        }
        if (svg_snippets.length == 0) {
          console.error(`No svg snippet for ${rule.type} found`);
        }

        let svg_snippet = svg_snippets[0];
        //Generate the svg part
        rule_entities.forEach((e) => {
          if (!svgDoc.get(`//*[@id='${e}']`)) {
            layer_element.addChild(
              svg_snippet.clone().attr({ id: e, "inkscape:label": e })
            );
            console.info(`Entity ${e} has been added to SVG`);
          } else {
            console.info(`Entity ${e} already exists in SVG`);
          }
        });
      }
      fs.writeFileSync(svg_file_name, svgDoc.toString());
      fs.writeFileSync(
        __dirname + "/ha_rules.yml",
        yaml.dump(ha_floorplan_rules, { lineWidth: 1000 })
      );
    });
  });

  req.end();
} catch (err) {
  console.error(
    "Failed to get entities - please ensure that Home Assistant server is available and that the long lived token is correct."
  );
}
}