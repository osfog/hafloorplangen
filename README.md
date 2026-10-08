# hafloorplangen

Small tool for populating [ha-floorplan](https://experiencelovelace.github.io/ha-floorplan/) SVG documents with entities fetched from a Home Assistant server, and generating the matching floorplan rules.

Instead of drawing a symbol for every light, sensor and switch by hand, you draw one template symbol per kind of device. The tool clones it once for every matching entity, so all you have to do is move the new symbols into place. Running it again later only adds symbols for new entities; symbols you have already placed are left untouched.

## Installation

Node.js 18 or later and npm are needed:
https://nodejs.org/en/learn/getting-started/how-to-install-nodejs

Clone or download the repository, open a terminal in its folder and install the dependencies:

```sh
npm install
```

## Running

```sh
node genfloorplan.js -s <svg file> -r <rules file> -u <home assistant url> -t <token>
```

| Option | Alias | Description |
| --- | --- | --- |
| `--svg` | `-s` | The floorplan SVG file to update |
| `--rules` | `-r` | The rules file describing which entities to add (see [Rules](#rules)) |
| `--url` | `-u` | Url to your Home Assistant server, e.g. `http://homeassistant.local:8123` |
| `--token` | `-t` | A Home Assistant [long lived access token](https://www.home-assistant.io/docs/authentication/#your-account-profile), created at the bottom of the security tab of your user profile |
| `--card` | `-c` | Optional. Also write the generated rules into the floorplan card in your dashboard (see [Updating the dashboard](#updating-the-dashboard)) |
| `--help` | `-h` | Show the help |

Example using the files in the `example` folder:

```sh
node genfloorplan.js -s example/planer.svg -r example/rules.yml -u http://homeassistant.local:8123 -t 12345678
```

When it runs, the tool:

1. Fetches all entities from Home Assistant.
2. For each rule, finds the matching entities and adds a symbol for each one that is not already in the SVG.
3. Offers to remove symbols it added earlier whose entity no longer exists in Home Assistant.
4. Saves the SVG, first backing up the original as `<svg file>.<random>.bak`. If nothing changed, the SVG is left as it is.
5. Writes the generated floorplan rules to `ha_rules.yml` in the application folder. Copy these into your ha-floorplan configuration.

## Updating the dashboard

With `--card`, the tool also connects to the Home Assistant WebSocket API, searches every dashboard for `custom:floorplan-card` cards (also inside sections, stacks and other nested cards) and replaces the card's `rules` with the generated ones, so you don't have to copy `ha_rules.yml` by hand.

- The card whose `image` has the same file name as the SVG is used. If there is only one floorplan card, it is used whatever its image.
- You are asked before the card is changed, and the dashboard config is first backed up as `lovelace_<dashboard>.<random>.bak.json` in the application folder.
- All rules in the card are replaced, so keep any hand written rules in the rules file.
- Dashboards in YAML mode, and cards that load their config from a separate file, can't be changed this way.
- The token must belong to an administrator, and Node.js 22 or later is needed.

If the SVG is open in Inkscape, use *File → Revert* to load the updated version.

## Preparing the SVG

The tool works with two kinds of elements, both identified by their Inkscape label (the name shown in the *Layers and Objects* panel):

- **Template symbols** are labelled `floorplan.<name>`, for example `floorplan.light` or `floorplan.door`. The tool clones one of these for every entity. An element with the id `floorplan.<name>` works too. A good place for the templates is a separate reference layer outside the visible floor plan.
- **Layers** are labelled `<name>`, for example `light` or `door`. The cloned symbols are placed in the layer with the same name. A layer that doesn't exist is created.

Each cloned symbol gets the entity id as its `id` and label, which is what ha-floorplan uses to connect it to the entity. It is also marked with a `hafloorplan:entity` attribute, so the tool can recognise the symbols it created when an entity is later removed from Home Assistant.

`example/planer.svg` contains a floor plan with template symbols for lights, temperature, doors, motion, smoke, leaks, fans and irrigation.

## Rules

The rules file is a YAML list. Each rule selects some entities and says which symbol to use for them and which ha-floorplan rule to generate:

```yaml
- type: binary_sensor        # entity domain to select
  attribute:                 # optional: attributes the entity must have
    device_class: door
  svg_primitive: door        # symbol floorplan.door, placed in layer door
  rules:                     # copied to ha_rules.yml, with the entities added
    state_action:
      action: call-service
      service: floorplan.class_set
      service_data: door-${entity.state}
    tap_action: more-info
```

| Key | Description |
| --- | --- |
| `type` | The entity domain to select, e.g. `light`, `switch`, `binary_sensor`. Required unless `entity_id` is given. |
| `entity_id` | Select one specific entity instead of filtering by type. |
| `attribute` | Optional. Only select entities whose attributes all equal the given values, e.g. `device_class: temperature`. |
| `friendly_name_includes` | Optional. Only select entities whose friendly name contains this text (not case sensitive). |
| `entity_id_includes` | Optional. Only select entities whose entity id contains this text (not case sensitive). |
| `svg_primitive` | Name of the template symbol (`floorplan.<svg_primitive>`) and layer (`<svg_primitive>`) to use. Defaults to `type`. |
| `rules` | Required. The [ha-floorplan rule](https://experiencelovelace.github.io/ha-floorplan/) to generate; the matched entities are added to it as `entities`. |

Rules are applied in order, and an entity is only included by the first rule that matches it. So put specific rules (a single `entity_id`, or a name filter) before general ones (all entities of a `type`).

Templates like `${entity.state}` can also be written as `\${entity.state}`, as in the example file. The backslash is removed in `ha_rules.yml`.

See `example/rules.yml` for a complete example.

## Exporting the house as a plain SVG

`exportboundary.js` exports everything inside a boundary object as a plain SVG, cropped to the boundary, e.g. to use only the house part of the drawing in a dashboard:

```sh
node exportboundary.js -s <svg file> -o <output file>
```

| Option | Alias | Description |
| --- | --- | --- |
| `--svg` | `-s` | The floorplan SVG file to export from |
| `--out` | `-o` | The plain SVG file to write |
| `--boundary` | `-b` | Optional. Label or id of the boundary object, default `HouseBoundry` |
| `--include-boundary` | `-i` | Optional. Also include the boundary object itself in the export |
| `--card` | `-c` | Optional. Also embed the plain SVG as the image of the floorplan card in your dashboard (see below) |
| `--url` | `-u` | Url to your Home Assistant server, needed with `--card` |
| `--token` | `-t` | A Home Assistant long lived access token, needed with `--card` |

- Draw the boundary, for example a rectangle, around the area to export and label it `HouseBoundry` in the *Layers and Objects* panel.
- Every visible object whose bounding box is completely inside the boundary is exported. Groups that are only partly inside are searched for the objects in them that are. Hidden layers and objects are left out.
- Inkscape specific data is removed, but ids are kept so the entity symbols still work with ha-floorplan.
- Inkscape 1.x must be installed, it is used to measure the objects and to write the plain SVG.

### Embedding the SVG in the dashboard

With `--card`, the plain SVG is stored in the floorplan card itself, as a `data:` url in the card's `image`, so the file doesn't have to be copied to the `www` folder of Home Assistant. Together with `genfloorplan.js --card`, only the url and a long lived access token are needed to update the dashboard:

```sh
node genfloorplan.js -s planer.svg -r rules.yml -u http://homeassistant.local:8123 -t <token> --card
node exportboundary.js -s planer.svg -o house.svg -u http://homeassistant.local:8123 -t <token> --card
```

- The card is found the same way as with `genfloorplan.js --card`, by the file name of the output SVG or as the only floorplan card. You are asked before it is changed, and the dashboard config is first backed up.
- The card's `image` is replaced with `{ location: <data url>, cache: true }`. Caching must be on, since ha-floorplan otherwise adds a query to the url which breaks the data url.
- The SVG is sent with the dashboard config every time the dashboard is loaded, so keep it reasonably small. A warning is shown above 1 MB.
- The card's `stylesheet` is not changed.
