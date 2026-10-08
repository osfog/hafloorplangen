#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * HA Floorplan boundary export
 *
 * Exports the part of a floorplan SVG that lies inside a boundary object
 * (by default the one labelled 'HouseBoundry') as a plain SVG, cropped to
 * the boundary.
 *
 *  1. The bounding box of every element is queried from Inkscape, so
 *     transforms, strokes and text are measured the way Inkscape draws them.
 *  2. Every visible element whose bounding box lies inside the boundary's is
 *     kept. Groups that are only partly inside are searched for elements that
 *     are, everything else is removed.
 *  3. Inkscape crops the page to the boundary and writes a plain SVG, without
 *     Inkscape specific data. Element ids are kept, ha-floorplan uses them.
 *
 * Needs Inkscape 1.x on the PATH.
 */
const chalk = require('chalk');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');
const xpath = require('xpath');
const commandLineArgs = require('command-line-args');
const commandLineUsage = require('command-line-usage');
const { execFileSync } = require('child_process');

const namespaces = {
  inkscape: 'http://www.inkscape.org/namespaces/inkscape',
  svg: 'http://www.w3.org/2000/svg',
  hafloorplan: 'http://www.example.com/hafloorplan',
};

const select = xpath.useNamespaces(namespaces);

// containers searched for elements inside the boundary, and drawn elements
const GROUP_TAGS = new Set(['g', 'a', 'switch']);
const SHAPE_TAGS = new Set([
  'path', 'rect', 'circle', 'ellipse', 'line', 'polyline', 'polygon',
  'text', 'image', 'use', 'foreignObject',
]);

// ids given to elements without one so Inkscape reports their bounding box,
// removed again from the output
const TEMP_ID_PREFIX = 'hafloorplan-tmp-';

// how far (in px) an element may stick out of the boundary and still be
// inside, so walls drawn along the boundary are not lost to rounding
const TOLERANCE = 0.5;

const optionDefinitions = [
  {
    name: 'svg',
    alias: 's',
    type: String,
    description: 'The floorplan SVG file to export from',
    typeLabel: '<file>',
  },
  {
    name: 'out',
    alias: 'o',
    type: String,
    description: 'The plain SVG file to write',
    typeLabel: '<file>',
  },
  {
    name: 'boundary',
    alias: 'b',
    type: String,
    defaultValue: 'HouseBoundry',
    description: 'Label or id of the boundary object, default HouseBoundry',
    typeLabel: '<name>',
  },
  {
    name: 'include-boundary',
    alias: 'i',
    type: Boolean,
    description: 'Also include the boundary object itself in the export',
  },
  {
    name: 'help',
    alias: 'h',
    type: Boolean,
    description: 'Show this help',
  },
];
const requiredOptions = ['svg', 'out'];

// errors caused by bad input, printed without a stack trace
class UserError extends Error {}

const printUsage = () => {
  console.log(commandLineUsage([
    {
      header: 'HA Floorplan boundary export',
      content: `Exports everything inside the boundary object of a floorplan SVG as a plain SVG cropped to the boundary.

        - The boundary is found by its Inkscape label, or else its id.
        - Hidden elements are left out.
        - Inkscape must be installed.`,
    },
    {
      header: 'Options',
      optionList: optionDefinitions,
    },
    {
      header: 'Example',
      content: 'node exportboundary.js -s planer.svg -o house.svg',
    },
  ]));
};

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

const readSvg = (fileName) => {
  let xmlFile;
  try {
    xmlFile = fs.readFileSync(fileName, 'utf8');
  } catch (err) {
    throw new UserError(`Could not read SVG file ${fileName}: ${err.message}`);
  }
  // files written by early versions of genfloorplan.js use the hafloorplan
  // prefix without declaring it, which fails to parse
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

const runInkscape = (args) => {
  try {
    return execFileSync('inkscape', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new UserError('Inkscape was not found, install it and make sure it is on the PATH');
    }
    throw new UserError(`Inkscape failed: ${err.stderr ? err.stderr.toString() : err.message}`);
  }
};

// id -> {x, y, width, height} for every element with an id, in px
const queryBoundingBoxes = (fileName) => {
  const boxes = new Map();
  runInkscape(['--query-all', fileName]).split('\n').forEach((line) => {
    const parts = line.trim().split(',');
    if (parts.length < 5) {
      return;
    }
    const [x, y, width, height] = parts.splice(-4).map(Number);
    boxes.set(parts.join(','), {
      x, y, width, height,
    });
  });
  return boxes;
};

const elementChildren = (el) => Array.from(el.childNodes).filter((n) => n.nodeType === 1);

const isAncestorOf = (el, node) => {
  for (let n = node.parentNode; n; n = n.parentNode) {
    if (n === el) {
      return true;
    }
  }
  return false;
};

const isHidden = (el) => el.getAttribute('display') === 'none'
  || /(^|;)\s*display\s*:\s*none/.test(el.getAttribute('style') || '');

const findBoundary = (svgDoc, name) => {
  let found = select(`//*[@inkscape:label='${name}']`, svgDoc);
  if (found.length === 0) {
    found = select(`//*[@id='${name}']`, svgDoc);
  }
  if (found.length === 0) {
    throw new UserError(`No object labelled or with id '${name}' found in the SVG`);
  }
  if (found.length > 1) {
    console.warn(chalk.yellow(`More than one object named ${name} found, using the first`));
  }
  return found[0];
};

// remove everything under parent that is not inside the boundary box,
// returns the number of elements kept
const pruneOutside = (parent, boundary, boxes) => {
  const b = boxes.get(boundary.getAttribute('id'));
  const isInside = (el) => {
    const box = boxes.get(el.getAttribute('id'));
    return box
      && box.x >= b.x - TOLERANCE
      && box.y >= b.y - TOLERANCE
      && box.x + box.width <= b.x + b.width + TOLERANCE
      && box.y + box.height <= b.y + b.height + TOLERANCE;
  };

  let kept = 0;
  elementChildren(parent).forEach((el) => {
    const tag = el.localName;
    if (el === boundary || (!GROUP_TAGS.has(tag) && !SHAPE_TAGS.has(tag))) {
      // the boundary is needed to crop the page, it is removed after export
      return;
    }
    // the groups holding the boundary are kept even when nothing else in
    // them is, or the boundary would be removed with them
    const holdsBoundary = isAncestorOf(el, boundary);
    if (!holdsBoundary && !isHidden(el) && isInside(el)) {
      kept += 1;
    } else if (holdsBoundary || (GROUP_TAGS.has(tag) && !isHidden(el))) {
      const keptInGroup = pruneOutside(el, boundary, boxes);
      if (keptInGroup > 0 || holdsBoundary) {
        kept += keptInGroup;
      } else {
        parent.removeChild(el);
      }
    } else {
      parent.removeChild(el);
    }
  });
  return kept;
};

// strip what Inkscape's plain SVG export leaves behind that is ours
const cleanExport = (svgDoc, boundaryId, includeBoundary) => {
  if (!includeBoundary) {
    const boundary = select(`//*[@id='${boundaryId}']`, svgDoc, true);
    if (boundary) {
      boundary.parentNode.removeChild(boundary);
    }
  }
  select('//*[@id]', svgDoc).forEach((el) => {
    if (el.getAttribute('id').startsWith(TEMP_ID_PREFIX)) {
      el.removeAttribute('id');
    }
  });
  // the entity markers, and the namespace Inkscape declares on each of them
  select('//*', svgDoc).forEach((el) => {
    Array.from(el.attributes)
      .map((attr) => attr.name)
      .filter((name) => name === 'xmlns:hafloorplan' || name.startsWith('hafloorplan:'))
      .forEach((name) => el.removeAttribute(name));
  });
};

const main = () => {
  const options = parseCommandLine();
  if (!options || options.help) {
    printUsage();
    return options ? 0 : 1;
  }

  const svgDoc = readSvg(options.svg);
  // every element needs an id for Inkscape to report its bounding box
  let tempIds = 0;
  select('//*[not(@id)]', svgDoc).forEach((el) => {
    el.setAttribute('id', `${TEMP_ID_PREFIX}${tempIds}`);
    tempIds += 1;
  });

  const boundary = findBoundary(svgDoc, options.boundary);
  const boundaryId = boundary.getAttribute('id');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hafloorplan-'));
  try {
    const workFile = path.join(workDir, 'work.svg');
    fs.writeFileSync(workFile, new XMLSerializer().serializeToString(svgDoc));
    const boxes = queryBoundingBoxes(workFile);
    if (!boxes.has(boundaryId)) {
      throw new UserError(`Inkscape reported no size for ${options.boundary}, is it empty?`);
    }

    const kept = pruneOutside(svgDoc.documentElement, boundary, boxes);
    console.info(`Found ${kept} object(s) inside ${options.boundary}`);
    fs.writeFileSync(workFile, new XMLSerializer().serializeToString(svgDoc));

    // with --export-id but not --export-id-only, Inkscape keeps all objects
    // and crops the page to the boundary
    const exportFile = path.join(workDir, 'export.svg');
    runInkscape([workFile, `--export-id=${boundaryId}`, '--export-plain-svg', '--export-type=svg', '-o', exportFile]);
    if (!fs.existsSync(exportFile)) {
      throw new UserError('Inkscape did not write the exported SVG');
    }

    const exportDoc = readSvg(exportFile);
    cleanExport(exportDoc, boundaryId, options['include-boundary']);
    fs.writeFileSync(options.out, new XMLSerializer().serializeToString(exportDoc));
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
  console.info(`Plain SVG written to ${options.out}`);
  return 0;
};

try {
  process.exitCode = main();
} catch (err) {
  console.error(chalk.red(err instanceof UserError ? err.message : err.stack));
  process.exitCode = 1;
}
