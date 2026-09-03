import { Setting, TextComponent } from "obsidian";

import { DEFAULT_PROPERTY_COLOR } from "../data/colorPalette";
import type { TimelineLevel } from "../data/historyParser";
import { GlobalValueStyles } from "../data/valueStyles";
import { addPalettePicker } from "./dashboardSettings";

export interface ValueSettingsHost {
  getGlobalValueStyles(): GlobalValueStyles;
  save(): Promise<void>;
  refreshDashboardViews(): void;
}

function addLevelOptions(dropdown: { addOption(value: string, display: string): unknown }): void {
  dropdown.addOption("inherit", "No default level");
  for (let level = 0; level <= 4; level++) dropdown.addOption(String(level), `Level ${level}`);
}

/**
 * Vault-wide defaults for tracked-property values. Every dashboard starts from
 * these; a dashboard's own mapping or color always wins.
 */
export function renderValueSettingsPane(pane: HTMLElement, host: ValueSettingsHost): void {
  pane.createEl("p", {
    text: "Set a level and color once per property value and every dashboard picks them up. A dashboard's own value mapping or color overrides the default here.",
    cls: "setting-item-description",
  });

  const list = pane.createDiv({ cls: "property-logs-map-list" });
  const save = async () => {
    await host.save();
    host.refreshDashboardViews();
  };

  const draw = () => {
    list.empty();
    const styles = host.getGlobalValueStyles();
    const values = Object.keys(styles).sort((first, second) =>
      first.localeCompare(second, undefined, { numeric: true, sensitivity: "base" }));

    if (values.length === 0) {
      list.createEl("p", {
        text: "No global values yet.",
        cls: "setting-item-description",
      });
      return;
    }

    values.forEach((value) => {
      const style = styles[value];
      const row = list.createDiv({ cls: "property-logs-map-row" });
      const setting = new Setting(row).setName(value);
      setting.addDropdown((dropdown) => {
        addLevelOptions(dropdown);
        dropdown
          .setValue(style.level === null ? "inherit" : String(style.level))
          .onChange(async (next) => {
            style.level = next === "inherit" ? null : Number(next) as TimelineLevel;
            await save();
          });
      });
      addPalettePicker(setting, style.color ?? "", async (color) => {
        style.color = color;
        await save();
      });
      setting.addExtraButton((button) => button
        .setIcon("trash")
        .setTooltip(`Remove ${value}`)
        .onClick(async () => {
          delete host.getGlobalValueStyles()[value];
          await save();
          draw();
        }));
    });
  };
  draw();

  let valueInput: TextComponent;
  let level: TimelineLevel | null = null;
  let color: string = DEFAULT_PROPERTY_COLOR;
  const add = async () => {
    const value = valueInput.getValue().trim();
    if (!value) return;
    host.getGlobalValueStyles()[value] = { level, color };
    valueInput.setValue("");
    await save();
    draw();
  };

  const addSetting = new Setting(pane)
    .setName("Add global value")
    .setDesc("The value as it appears in frontmatter, such as Active or Blocked.")
    .addText((text) => {
      valueInput = text;
      text.setPlaceholder("Active");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void add();
      });
    })
    .addDropdown((dropdown) => {
      addLevelOptions(dropdown);
      dropdown.setValue("inherit").onChange((next) => {
        level = next === "inherit" ? null : Number(next) as TimelineLevel;
      });
    });
  addPalettePicker(addSetting, color, (next) => {
    color = next;
  });
  addSetting.addButton((button) => button.setButtonText("Add").setCta().onClick(add));
}
