# Chromefile

A Chromefile is a small YAML file that declares how Google Chrome (and Chromium-based browsers) should be set up: tab layout, hotkeys, and more over time. Like a Brewfile, you keep it in your dotfiles and any tool that implements this open, tool-neutral specification can apply it. It describes the result you want, not browser internals, so the same file stays readable and portable across machines, platforms and tools.

```yaml
# yaml-language-server: $schema=https://raw.githubusercontent.com/whirlwin/chromefile/main/schema/chromefile.schema.json
version: 1

tabs:
  layout: vertical          # vertical | horizontal

hotkeys:
  tab.next: Command+J       # the tab below (vertical) or to the right (horizontal), wrapping around
  tab.previous: Command+K
```

## Specification

- [SPEC.md](SPEC.md): the Chromefile Specification, version 1.
- [schema/chromefile.schema.json](schema/chromefile.schema.json): JSON Schema (draft 2020-12) for validation and editor support.

## Editor setup

Editors using [yaml-language-server](https://github.com/redhat-developer/yaml-language-server) (VS Code with the Red Hat YAML extension, Neovim, Helix, Zed and others) pick up the schema from the first-line comment and give completion, hover docs and validation. Since `Chromefile` has no extension, tell your editor it is YAML (in VS Code: `"files.associations": { "Chromefile": "yaml" }`).

To validate from the command line:

```sh
uvx check-jsonschema --default-filetype yaml \
  --schemafile https://raw.githubusercontent.com/whirlwin/chromefile/main/schema/chromefile.schema.json \
  Chromefile
```

## Status

Draft, version 1. The format may change incompatibly until version 1 is marked final.

## Contributing

To propose a new setting or hotkey action, [open an issue](https://github.com/whirlwin/chromefile/issues) describing the user-visible behaviour you want to declare. See [section 9 of the spec](SPEC.md#9-extending-the-specification) for naming conventions and how versions evolve.

## License

- The specification and documentation ([SPEC.md](SPEC.md), this README) are licensed under [CC BY 4.0](LICENSE-SPEC).
- The schema, tests and other code are licensed under the [MIT License](LICENSE).
