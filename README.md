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
