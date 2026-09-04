import { App, Setting, TextComponent } from "obsidian";

import {
  createDashboardSettings,
  DashboardPropertyRule,
  DashboardSettings,
} from "../data/dashboard";
import { GlobalValueStyles, knownValues } from "../data/valueStyles";
import { applyTooltip } from "../view/tooltips";
import type { TimelineLevel } from "../data/historyParser";
import {
  COLOR_PALETTE,
  DEFAULT_PROPERTY_COLOR,
  isLegacyHexColor,
  paletteCssColor,
  paletteValue,
} from "../data/colorPalette";

export interface DashboardSettingsHost {
  app: App;
  getDashboards(): DashboardSettings[];
  setDashboards(dashboards: DashboardSettings[]): Promise<void>;
  duplicateDashboard(id: string): Promise<DashboardSettings | null>;
  openDashboard(id: string): Promise<void>;
  refreshDashboardViews(): void;
  loadAllStatuses(): Promise<void>;
  getGlobalValueStyles(): GlobalValueStyles;
}

function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;
}

function addLevelOptions(dropdown: { addOption(value: string, display: string): unknown }): void {
  for (let level = 0; level <= 4; level++) dropdown.addOption(String(level), `Level ${level}`);
}

export function addPalettePicker(
  setting: Setting,
  currentValue: string,
  onChange: (value: string) => Promise<void> | void
): void {
  const picker = setting.controlEl.createDiv({ cls: "property-logs-palette-picker" });
  picker.setAttribute("role", "radiogroup");
  picker.setAttribute("aria-label", `${setting.nameEl.textContent ?? "Color"} palette`);

  const choices: Array<{ label: string; value: string }> = COLOR_PALETTE.map((color) => ({
    label: color.label,
    value: paletteValue(color.id),
  }));
  if (isLegacyHexColor(currentValue)) {
    choices.unshift({ label: "Saved custom color", value: currentValue });
  }

  const buttons: HTMLButtonElement[] = [];
  const updateSelection = (selected: string) => {
    buttons.forEach((button) => {
      const active = button.dataset.value === selected;
      button.toggleClass("is-selected", active);
      button.setAttribute("aria-checked", String(active));
      button.tabIndex = active ? 0 : -1;
    });
  };

  choices.forEach((choice) => {
    const button = picker.createEl("button", {
      cls: "property-logs-palette-swatch",
      attr: {
        type: "button",
        role: "radio",
        "aria-label": choice.label,
      },
    });
    applyTooltip(button, choice.label);
    button.dataset.value = choice.value;
    button.style.setProperty(
      "--property-logs-swatch-color",
      paletteCssColor(choice.value) ?? choice.value
    );
    button.addEventListener("click", async () => {
      updateSelection(choice.value);
      await onChange(choice.value);
    });
    buttons.push(button);
  });
  updateSelection(currentValue);
}

function renderStringList(
  container: HTMLElement,
  title: string,
  description: string,
  placeholder: string,
  values: string[],
  save: () => Promise<void>
): void {
  container.createEl("h4", { text: title });
  container.createEl("p", { text: description, cls: "setting-item-description" });
  const list = container.createDiv({ cls: "property-logs-compact-list" });

  const draw = () => {
    list.empty();
    values.forEach((value, index) => {
      new Setting(list)
        .setName(value)
        .addExtraButton((button) => button
          .setIcon("trash")
          .setTooltip(`Remove ${value}`)
          .onClick(async () => {
            values.splice(index, 1);
            await save();
            draw();
          }));
    });
  };
  draw();

  let input: TextComponent;
  const add = async () => {
    const rawValue = input.getValue().trim();
    const value = title === "Tags" ? rawValue.replace(/^#/, "") : rawValue;
    if (!value || values.includes(value)) return;
    values.push(value);
    input.setValue("");
    await save();
    draw();
  };
  new Setting(container)
    .addText((text) => {
      input = text;
      text.setPlaceholder(placeholder);
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void add();
      });
    })
    .addButton((button) => button.setButtonText("Add").onClick(add));
}

function renderPropertyRules(
  container: HTMLElement,
  title: string,
  description: string,
  rules: DashboardPropertyRule[],
  save: () => Promise<void>
): void {
  container.createEl("h4", { text: title });
  container.createEl("p", { text: description, cls: "setting-item-description" });
  const list = container.createDiv({ cls: "property-logs-compact-list" });
  const draw = () => {
    list.empty();
    rules.forEach((rule, index) => {
      const label = rule.value ? `${rule.key} = ${rule.value}` : `${rule.key} exists`;
      new Setting(list)
        .setName(label)
        .addExtraButton((button) => button
          .setIcon("trash")
          .setTooltip(`Remove ${label}`)
          .onClick(async () => {
            rules.splice(index, 1);
            await save();
            draw();
          }));
    });
  };
  draw();

  let keyInput: TextComponent;
  let valueInput: TextComponent;
  const add = async () => {
    const key = keyInput.getValue().trim();
    const value = valueInput.getValue().trim();
    if (!key) return;
    if (rules.some((rule) => rule.key === key && rule.value === value)) return;
    rules.push({ key, value });
    keyInput.setValue("");
    valueInput.setValue("");
    await save();
    draw();
  };
  const addRuleSetting = new Setting(container)
    .addText((text) => {
      keyInput = text;
      text.setPlaceholder("Property key");
    })
    .addText((text) => {
      valueInput = text;
      text.setPlaceholder("Value (blank = exists)");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void add();
      });
    })
    .addButton((button) => button.setButtonText("Add").onClick(add));
  addRuleSetting.settingEl.addClass("property-logs-property-rule-add");
}

function renderColorMap(
  container: HTMLElement,
  dashboard: DashboardSettings,
  save: () => Promise<void>
): void {
  const list = container.createDiv({ cls: "property-logs-map-list" });
  const draw = () => {
    list.empty();
    Object.entries(dashboard.colorPropertyMap).forEach(([value, color]) => {
      const row = list.createDiv({ cls: "property-logs-map-row" });
      const setting = new Setting(row).setName(value);
      addPalettePicker(setting, color, async (next) => {
        dashboard.colorPropertyMap[value] = next;
        await save();
      });
      setting.addExtraButton((button) => button
          .setIcon("trash")
          .setTooltip(`Remove ${value}`)
          .onClick(async () => {
            delete dashboard.colorPropertyMap[value];
            await save();
            draw();
          }));
    });
  };
  draw();

  let valueInput: TextComponent;
  let selectedColor: string = DEFAULT_PROPERTY_COLOR;
  const add = async () => {
    const value = valueInput.getValue().trim();
    if (!value) return;
    dashboard.colorPropertyMap[value] = selectedColor;
    valueInput.setValue("");
    await save();
    draw();
  };
  const addSetting = new Setting(container)
    .setName("Add property color")
    .addText((text) => {
      valueInput = text;
      text.setPlaceholder("Property value");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void add();
      });
    });
  addPalettePicker(addSetting, selectedColor, (color) => {
    selectedColor = color;
  });
  addSetting.addButton((button) => button.setButtonText("Add").onClick(add));
}

/** Per-dashboard overrides of the vault-wide value colors. */
function renderValueColorMap(
  container: HTMLElement,
  dashboard: DashboardSettings,
  host: DashboardSettingsHost,
  save: () => Promise<void>
): void {
  const globalStyles = host.getGlobalValueStyles();
  container.createEl("p", {
    text: "Bars take the color of the tracked value. Values fall back to the vault-wide colors in the Values tab; anything set here overrides them for this dashboard only.",
    cls: "setting-item-description",
  });

  const list = container.createDiv({ cls: "property-logs-map-list" });
  const draw = () => {
    list.empty();
    const values = knownValues(globalStyles, dashboard.levelMapping, dashboard.valueColors);
    if (values.length === 0) {
      list.createEl("p", {
        text: "Add a value mapping above, or a global value in the Values tab, to color it here.",
        cls: "setting-item-description",
      });
      return;
    }
    values.forEach((value) => {
      const row = list.createDiv({ cls: "property-logs-map-row" });
      const override = dashboard.valueColors[value];
      const setting = new Setting(row)
        .setName(value)
        .setDesc(override
          ? "Overrides the vault-wide color."
          : globalStyles[value]?.color
            ? "Using the vault-wide color."
            : "No color yet.");
      addPalettePicker(setting, override ?? globalStyles[value]?.color ?? "", async (color) => {
        dashboard.valueColors[value] = color;
        await save();
        draw();
      });
      if (override) {
        setting.addExtraButton((button) => button
          .setIcon("rotate-ccw")
          .setTooltip("Use the vault-wide color")
          .onClick(async () => {
            delete dashboard.valueColors[value];
            await save();
            draw();
          }));
      }
    });
  };
  draw();
}

function renderDashboardEditor(
  container: HTMLElement,
  dashboard: DashboardSettings,
  host: DashboardSettingsHost,
  redrawAll: () => void
): void {
  container.empty();
  const save = async () => {
    await host.setDashboards(host.getDashboards());
    host.refreshDashboardViews();
  };

  const heading = new Setting(container)
    .setName("Dashboard")
    .setDesc("A saved timeline with its own scope, tracked property, colors, and layout.")
    .addText((text) => text
      .setValue(dashboard.name)
      .onChange(async (value) => {
        dashboard.name = value.trim() || "Dashboard";
        await save();
      }))
    .addButton((button) => button
      .setButtonText("Open")
      .setCta()
      .onClick(() => host.openDashboard(dashboard.id)))
    .addExtraButton((button) => button
      .setIcon("copy")
      .setTooltip("Duplicate dashboard")
      .onClick(async () => {
        await host.duplicateDashboard(dashboard.id);
        redrawAll();
      }))
    .addExtraButton((button) => button
      .setIcon("trash")
      .setTooltip("Delete dashboard")
      .onClick(async () => {
        const remaining = host.getDashboards().filter((item) => item.id !== dashboard.id);
        await host.setDashboards(remaining);
        redrawAll();
      }));
  heading.settingEl.addClass("property-logs-dashboard-heading");

  container.createEl("h3", { text: "Tracked property" });
  new Setting(container)
    .setName("Frontmatter property")
    .setDesc("The live property that drives levels. Property Logs resolves its configured history key, or uses {property}Set.")
    .addText((text) => text
      .setPlaceholder("relevant")
      .setValue(dashboard.trackedPropertyKey)
      .onChange(async (value) => {
        dashboard.trackedPropertyKey = value.trim();
        await save();
        await host.loadAllStatuses();
      }));

  const mappingList = container.createDiv({ cls: "property-logs-map-list" });
  const drawMappings = () => {
    mappingList.empty();
    Object.entries(dashboard.levelMapping).forEach(([value, mappedLevel]) => {
      new Setting(mappingList)
        .setName(value)
        .addDropdown((dropdown) => {
          addLevelOptions(dropdown);
          dropdown.setValue(String(mappedLevel)).onChange(async (next) => {
            dashboard.levelMapping[value] = Number(next) as TimelineLevel;
            await save();
          });
        })
        .addExtraButton((button) => button
          .setIcon("trash")
          .setTooltip(`Remove ${value}`)
          .onClick(async () => {
            delete dashboard.levelMapping[value];
            await save();
            drawMappings();
          }));
    });
  };
  drawMappings();

  let mappedValueInput: TextComponent;
  let mappedLevel: TimelineLevel = 1;
  const addMapping = async () => {
    const value = mappedValueInput.getValue().trim();
    if (!value) return;
    dashboard.levelMapping[value] = mappedLevel;
    mappedValueInput.setValue("");
    await save();
    drawMappings();
  };
  new Setting(container)
    .setName("Add value mapping")
    .addText((text) => {
      mappedValueInput = text;
      text.setPlaceholder("Property value");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void addMapping();
      });
    })
    .addDropdown((dropdown) => {
      addLevelOptions(dropdown);
      dropdown.setValue("1").onChange((value) => {
        mappedLevel = Number(value) as TimelineLevel;
      });
    })
    .addButton((button) => button.setButtonText("Add").onClick(addMapping));

  new Setting(container)
    .setName("Level when history is unset")
    .setDesc("Creates an implicit segment from the note creation date. Level 0 hides it.")
    .addDropdown((dropdown) => {
      addLevelOptions(dropdown);
      dropdown.setValue(String(dashboard.defaultLevelForUnset)).onChange(async (value) => {
        dashboard.defaultLevelForUnset = Number(value) as TimelineLevel;
        await save();
      });
    });

  new Setting(container)
    .setName("Level for unmapped values")
    .setDesc("Used for free text and existing values that are not in the map.")
    .addDropdown((dropdown) => {
      addLevelOptions(dropdown);
      dropdown.setValue(String(dashboard.unmappedValueLevel)).onChange(async (value) => {
        dashboard.unmappedValueLevel = Number(value) as TimelineLevel;
        await save();
      });
    });

  container.createEl("h3", { text: "Colors" });
  const colorSection = container.createDiv();
  const drawColors = () => {
    colorSection.empty();
    if (dashboard.colorMode === "value") {
      renderValueColorMap(colorSection, dashboard, host, save);
    } else if (dashboard.colorMode === "level") {
      colorSection.createEl("p", {
        text: "Choose a palette color once; it automatically adapts to light and dark themes. Level 0 remains hidden.",
        cls: "setting-item-description",
      });
      ([0, 1, 2, 3, 4] as TimelineLevel[]).forEach((level) => {
        const row = colorSection.createDiv({ cls: "property-logs-color-row" });
        const setting = new Setting(row).setName(`Level ${level}`);
        addPalettePicker(setting, dashboard.levelColors[level], async (value) => {
          dashboard.levelColors[level] = value;
          await save();
        });
      });
    } else {
      new Setting(colorSection)
        .setName("Color property")
        .setDesc("A current frontmatter property such as tags, area, or owner.")
        .addText((text) => text
          .setPlaceholder("tags")
          .setValue(dashboard.colorProperty)
          .onChange(async (value) => {
            dashboard.colorProperty = value.trim();
            await save();
          }));
      renderColorMap(colorSection, dashboard, save);
    }
  };
  new Setting(container)
    .setName("Color bars by")
    .addDropdown((dropdown) => dropdown
      .addOption("level", "Level")
      .addOption("property", "Property")
      .addOption("value", "Tracked value")
      .setValue(dashboard.colorMode)
      .onChange(async (value) => {
        dashboard.colorMode = value === "property" || value === "value" ? value : "level";
        await save();
        drawColors();
      }));
  drawColors();

  container.createEl("h3", { text: "Dashboard scope" });
  container.createEl("p", {
    text: "Exclusions always win. When more than one inclusion category is configured, a note must match each category; multiple values inside one category are alternatives.",
    cls: "setting-item-description",
  });
  const scope = dashboard.scopeFilter;
  const scopeGrid = container.createDiv({ cls: "property-logs-scope-grid" });
  const included = scopeGrid.createDiv({ cls: "property-logs-scope-card" });
  included.createEl("h4", { text: "Include" });
  renderStringList(included, "Folders", "Folder paths; child folders are included.", "Projects/Active", scope.includedFolders, save);
  renderStringList(included, "Tags", "Tags without #.", "topic", scope.includedTags, save);
  renderPropertyRules(included, "Properties", "Blank value means the property only needs to exist.", scope.includedProperties, save);
  const excluded = scopeGrid.createDiv({ cls: "property-logs-scope-card" });
  excluded.createEl("h4", { text: "Exclude" });
  renderStringList(excluded, "Folders", "Excluded paths take priority.", "Archive", scope.excludedFolders, save);
  renderStringList(excluded, "Tags", "Excluded tags take priority.", "hidden", scope.excludedTags, save);
  renderPropertyRules(excluded, "Properties", "Any matching rule excludes the note.", scope.excludedProperties, save);

  container.createEl("h3", { text: "Rows and toolbar" });
  new Setting(container)
    .setName("Open note from timeline block")
    .setDesc("The other gesture opens the status value picker, so both actions remain available.")
    .addDropdown((dropdown) => dropdown
      .addOption("ctrl-click", "Ctrl-click opens note; click changes value")
      .addOption("click", "Click opens note; Ctrl-click changes value")
      .setValue(dashboard.noteOpenGesture)
      .onChange(async (value) => {
        dashboard.noteOpenGesture = value === "click" ? "click" : "ctrl-click";
        await save();
      }));

  new Setting(container)
    .setName("Calendar axis")
    .setDesc("Draws clickable day, week, month, quarter, and year cells with matching dividers.")
    .addToggle((toggle) => toggle
      .setValue(dashboard.showPeriodAxis)
      .onChange(async (value) => {
        dashboard.showPeriodAxis = value;
        await save();
      }));

  new Setting(container)
    .setName("Notes from periodic notes")
    .setDesc("Shows marked task lines such as `- [n] …` from periodic notes on this timeline.")
    .addToggle((toggle) => toggle
      .setValue(dashboard.showJournalNotes)
      .onChange(async (value) => {
        dashboard.showJournalNotes = value;
        await save();
      }));

  new Setting(container)
    .setName("Properties beside note title")
    .setDesc("Comma-separated frontmatter or history-entry keys. History keys show their latest value.")
    .addText((text) => text
      .setPlaceholder("owner, tags, priority")
      .setValue(dashboard.rowProperties.join(", "))
      .onChange(async (value) => {
        dashboard.rowProperties = value.split(",").map((key) => key.trim()).filter(Boolean);
        await save();
      }));

  new Setting(container)
    .setName("Default group")
    .setDesc("Use status, none, folder, level, or property:<key>. Status creates stacked note bars inside status rows.")
    .addText((text) => text
      .setPlaceholder("status or property:area")
      .setValue(dashboard.groupBy)
      .onChange(async (value) => {
        const trimmed = value.trim();
        dashboard.groupBy = trimmed === "status" || trimmed === "folder" || trimmed === "level" || trimmed.startsWith("property:")
          ? trimmed as DashboardSettings["groupBy"]
          : "none";
        await save();
      }));

  new Setting(container)
    .setName("Default sort")
    .setDesc("Use alphabetical, level, recent, or property:<key>.")
    .addText((text) => text
      .setPlaceholder("alphabetical or property:priority")
      .setValue(dashboard.sortBy)
      .onChange(async (value) => {
        const trimmed = value.trim();
        dashboard.sortBy = trimmed === "level" || trimmed === "recent" || trimmed.startsWith("property:")
          ? trimmed as DashboardSettings["sortBy"]
          : "alphabetical";
        await save();
      }))
    .addToggle((toggle) => toggle
      .setTooltip("Ascending")
      .setValue(dashboard.sortAscending)
      .onChange(async (value) => {
        dashboard.sortAscending = value;
        await save();
      }));
}

export function renderDashboardSettingsPane(
  pane: HTMLElement,
  host: DashboardSettingsHost
): void {
  let selectedId = host.getDashboards()[0]?.id ?? "";
  const redraw = () => {
    pane.empty();
    const dashboards = host.getDashboards();
    const chooser = pane.createDiv({ cls: "property-logs-dashboard-chooser" });
    const editor = pane.createDiv();

    if (dashboards.length === 0) {
      chooser.createEl("p", {
        text: "Create a dashboard to define its timeline, scope, and appearance.",
        cls: "setting-item-description",
      });
    }

    let active: DashboardSettings | undefined = dashboards.find((dashboard) => dashboard.id === selectedId)
      ?? dashboards[0];
    selectedId = active?.id ?? "";
    const drawActive = () => {
      if (active) renderDashboardEditor(editor, active, host, redraw);
      else editor.empty();
    };

    new Setting(chooser)
      .setName("Configured dashboards")
      .addDropdown((dropdown) => {
        dashboards.forEach((dashboard) => dropdown.addOption(dashboard.id, dashboard.name));
        if (active) dropdown.setValue(active.id);
        dropdown.onChange((id) => {
          selectedId = id;
          active = dashboards.find((dashboard) => dashboard.id === id);
          drawActive();
        });
      })
      .addButton((button) => button
        .setButtonText("Add dashboard")
        .setCta()
        .onClick(async () => {
          const next = createDashboardSettings(createId(), `Dashboard ${dashboards.length + 1}`);
          selectedId = next.id;
          await host.setDashboards([...dashboards, next]);
          redraw();
        }));
    drawActive();
  };
  redraw();
}
