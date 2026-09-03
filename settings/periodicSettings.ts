import { Setting, TextComponent, setIcon } from "obsidian";

import { DEFAULT_PROPERTY_COLOR, paletteCssColor } from "../data/colorPalette";
import {
  DEFAULT_JOURNAL_MARKERS,
  JournalMarkerStyle,
} from "../data/journalMarkers";
import {
  DEFAULT_PERIOD_WINDOW_DAYS,
  PERIOD_GRANULARITIES,
  PeriodGranularity,
} from "../data/periodic";
import { addPalettePicker } from "./dashboardSettings";

export interface PeriodicSettingsHost {
  getJournalMarkers(): JournalMarkerStyle[];
  setJournalMarkers(markers: JournalMarkerStyle[]): Promise<void>;
  getWeekStartsOn(): number;
  setWeekStartsOn(day: number): Promise<void>;
  getPeriodWindowDays(): Record<PeriodGranularity, number>;
  setPeriodWindowDays(days: Record<PeriodGranularity, number>): Promise<void>;
  hasJournalsPlugin(): boolean;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

const PERIOD_LABELS: Record<PeriodGranularity, string> = {
  day: "Daily note",
  week: "Weekly note",
  month: "Monthly note",
  quarter: "Quarterly note",
  year: "Yearly note",
};

/** Periodic-note integration: the calendar axis, embeds, and journal markers. */
export function renderPeriodicSettingsPane(pane: HTMLElement, host: PeriodicSettingsHost): void {
  pane.createEl("p", {
    text: host.hasJournalsPlugin()
      ? "The Journals plugin was detected, so clicking a day, week, month, quarter, or year on the timeline opens the matching journal note."
      : "Install the Journals plugin to open weekly, monthly, quarterly, and yearly notes from the timeline. Without it, only daily notes can be opened.",
    cls: "setting-item-description",
  });

  new Setting(pane)
    .setName("Week starts on")
    .setDesc("Used for the week cells and dividers on the timeline axis.")
    .addDropdown((dropdown) => {
      WEEKDAYS.forEach((day, index) => dropdown.addOption(String(index), day));
      dropdown.setValue(String(host.getWeekStartsOn())).onChange(async (value) => {
        await host.setWeekStartsOn(Number(value));
      });
    });

  pane.createEl("h3", { text: "Embedded dashboards" });
  pane.createEl("p", {
    text: "A ```property-logs code block centers on the period of the note it lives in. These spans decide how much calendar context each note type shows; a block can override them with zoom: 30d.",
    cls: "setting-item-description",
  });

  PERIOD_GRANULARITIES.forEach((granularity) => {
    new Setting(pane)
      .setName(PERIOD_LABELS[granularity])
      .setDesc(`Days of context shown around the period (default ${DEFAULT_PERIOD_WINDOW_DAYS[granularity]}).`)
      .addText((text) => {
        text
          .setPlaceholder(String(DEFAULT_PERIOD_WINDOW_DAYS[granularity]))
          .setValue(String(host.getPeriodWindowDays()[granularity]))
          .onChange(async (value) => {
            const days = Number(value);
            if (!Number.isFinite(days) || days < 1) return;
            await host.setPeriodWindowDays({
              ...host.getPeriodWindowDays(),
              [granularity]: Math.round(days),
            });
          });
        text.inputEl.type = "number";
        text.inputEl.min = "1";
      });
  });

  pane.createEl("h3", { text: "Notes from periodic notes" });
  pane.createEl("p", {
    text: "A task line in a periodic note becomes a note on that note's date. For example, `- [n] Felt good about this` uses the n marker below. Markers match Obsidian's checkbox syntax, so the same characters your theme styles work here.",
    cls: "setting-item-description",
  });

  const list = pane.createDiv({ cls: "property-logs-map-list" });
  const draw = () => {
    list.empty();
    const markers = host.getJournalMarkers();
    if (markers.length === 0) {
      list.createEl("p", {
        text: "No markers configured, so periodic-note lines are ignored.",
        cls: "setting-item-description",
      });
    }
    markers.forEach((marker, index) => {
      const row = list.createDiv({ cls: "property-logs-map-row" });
      const setting = new Setting(row).setName(`- [${marker.marker}]`);
      const preview = setting.nameEl.createSpan({ cls: "property-logs-marker-preview" });
      preview.style.setProperty(
        "--property-logs-marker-color",
        paletteCssColor(marker.color) ?? marker.color
      );
      setIcon(preview, marker.icon);

      setting.addText((text) => {
        text.setPlaceholder("Label").setValue(marker.label).onChange(async (value) => {
          marker.label = value.trim() || marker.marker;
          await host.setJournalMarkers(markers);
        });
        text.inputEl.addClass("property-logs-marker-label-input");
      });
      setting.addText((text) => {
        text.setPlaceholder("lucide icon").setValue(marker.icon).onChange(async (value) => {
          marker.icon = value.trim() || "message-square";
          await host.setJournalMarkers(markers);
          setIcon(preview, marker.icon);
        });
        text.inputEl.addClass("property-logs-marker-icon-input");
      });
      addPalettePicker(setting, marker.color, async (color) => {
        marker.color = color;
        preview.style.setProperty("--property-logs-marker-color", paletteCssColor(color) ?? color);
        await host.setJournalMarkers(markers);
      });
      setting.addExtraButton((button) => button
        .setIcon("trash")
        .setTooltip(`Remove ${marker.marker}`)
        .onClick(async () => {
          const next = markers.filter((_item, position) => position !== index);
          await host.setJournalMarkers(next);
          draw();
        }));
    });
  };
  draw();

  let markerInput: TextComponent;
  let labelInput: TextComponent;
  let iconInput: TextComponent;
  let color: string = DEFAULT_PROPERTY_COLOR;
  const add = async () => {
    const marker = markerInput.getValue().trim().slice(0, 1);
    if (!marker) return;
    const markers = host.getJournalMarkers();
    if (markers.some((item) => item.marker === marker)) return;
    await host.setJournalMarkers([...markers, {
      marker,
      label: labelInput.getValue().trim() || marker,
      icon: iconInput.getValue().trim() || "message-square",
      color,
    }]);
    markerInput.setValue("");
    labelInput.setValue("");
    iconInput.setValue("");
    draw();
  };

  const addSetting = new Setting(pane)
    .setName("Add marker")
    .setDesc("The character between the brackets, plus the icon and color it shows on the timeline.")
    .addText((text) => {
      markerInput = text;
      text.setPlaceholder("n");
      text.inputEl.maxLength = 1;
      text.inputEl.addClass("property-logs-marker-char-input");
    })
    .addText((text) => {
      labelInput = text;
      text.setPlaceholder("Note");
    })
    .addText((text) => {
      iconInput = text;
      text.setPlaceholder("pencil");
      text.inputEl.addEventListener("keydown", (event) => {
        if (event.key === "Enter") void add();
      });
    });
  addPalettePicker(addSetting, color, (next) => {
    color = next;
  });
  addSetting.addButton((button) => button.setButtonText("Add").setCta().onClick(add));

  new Setting(pane)
    .setName("Restore default markers")
    .setDesc("Replaces the list above with n, !, ?, i, *, and b.")
    .addButton((button) => button.setButtonText("Restore").onClick(async () => {
      await host.setJournalMarkers(DEFAULT_JOURNAL_MARKERS.map((marker) => ({ ...marker })));
      draw();
    }));
}
