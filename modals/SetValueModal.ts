import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile } from "obsidian";

import type { DashboardSettings } from "../data/dashboard";

export interface ValueWriter {
  app: App;
  setTrackedPropertyValue(file: TFile, frontmatterKey: string, value: string): Promise<void>;
  refreshDashboardViews(): void;
}

interface ValueChoice {
  value: string;
  level?: number;
  custom: boolean;
}

class CustomValueModal extends Modal {
  private value = "";

  constructor(app: App, private readonly onSubmit: (value: string) => Promise<void>) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Set custom value");
    new Setting(this.contentEl)
      .setName("Value")
      .addText((text) => {
        text.setPlaceholder("Enter any value").onChange((value) => {
          this.value = value;
        });
        text.inputEl.addEventListener("keydown", (event) => {
          if (event.key === "Enter") void this.submit();
        });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("Set value")
        .setCta()
        .onClick(() => this.submit()))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async submit(): Promise<void> {
    const value = this.value.trim();
    if (!value) return;
    try {
      await this.onSubmit(value);
      this.close();
    } catch (error) {
      console.error("Property Logs: failed to set custom value", error);
      new Notice("Property Logs could not update this note.");
    }
  }
}

export class SetValueModal extends FuzzySuggestModal<ValueChoice> {
  private readonly choices: ValueChoice[];

  constructor(
    app: App,
    private readonly writer: ValueWriter,
    private readonly file: TFile,
    private readonly dashboard: DashboardSettings
  ) {
    super(app);
    this.setPlaceholder(`Set ${dashboard.trackedPropertyKey} for ${file.basename}`);
    this.choices = [
      ...Object.entries(dashboard.levelMapping).map(([value, level]) => ({
        value,
        level,
        custom: false,
      })),
      { value: "Enter custom value…", custom: true },
    ];
  }

  getItems(): ValueChoice[] {
    return this.choices;
  }

  getItemText(item: ValueChoice): string {
    return item.custom ? item.value : `${item.value} — level ${item.level}`;
  }

  onChooseItem(item: ValueChoice): void {
    if (item.custom) {
      new CustomValueModal(this.app, (value) => this.write(value)).open();
      return;
    }
    void this.write(item.value);
  }

  private async write(value: string): Promise<void> {
    try {
      await this.writer.setTrackedPropertyValue(
        this.file,
        this.dashboard.trackedPropertyKey,
        value
      );
      this.writer.refreshDashboardViews();
    } catch (error) {
      console.error("Property Logs: failed to set value", error);
      new Notice("Property Logs could not update this note.");
      throw error;
    }
  }
}

export function openValuePicker(
  writer: ValueWriter,
  file: TFile,
  dashboard: DashboardSettings
): void {
  new SetValueModal(writer.app, writer, file, dashboard).open();
}
