import { App, FuzzySuggestModal, Modal, Notice, Setting, TFile, normalizePath } from "obsidian";

import type { DashboardSettings } from "../data/dashboard";
import { openValuePicker, ValueWriter } from "./SetValueModal";

export interface TopicHost extends ValueWriter {
  getDashboardFiles(dashboard: DashboardSettings): TFile[];
  noteHasTrackedHistory(file: TFile, dashboard: DashboardSettings): boolean;
  createDashboardNote(title: string, folder: string, dashboard: DashboardSettings): Promise<TFile>;
}

class ExistingNoteModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly host: TopicHost,
    private readonly dashboard: DashboardSettings
  ) {
    super(app);
    this.setPlaceholder("Choose an eligible note");
  }

  getItems(): TFile[] {
    return this.host.getDashboardFiles(this.dashboard);
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    if (this.host.noteHasTrackedHistory(file, this.dashboard)) {
      new Notice(`${file.basename} already has timeline history.`);
      this.host.refreshDashboardViews();
      return;
    }
    openValuePicker(this.host, file, this.dashboard);
  }
}

class NewNoteModal extends Modal {
  private title = "";
  private folder: string;

  constructor(
    app: App,
    private readonly host: TopicHost,
    private readonly dashboard: DashboardSettings
  ) {
    super(app);
    this.folder = dashboard.scopeFilter.includedFolders.length > 0
      ? dashboard.scopeFilter.includedFolders[0]
      : "";
  }

  onOpen(): void {
    this.titleEl.setText("Create timeline note");
    new Setting(this.contentEl)
      .setName("Title")
      .addText((text) => {
        text.setPlaceholder("Note title").onChange((value) => {
          this.title = value;
        });
        window.setTimeout(() => text.inputEl.focus(), 50);
      });
    new Setting(this.contentEl)
      .setName("Folder")
      .setDesc("Leave blank for the vault root.")
      .addText((text) => text
        .setPlaceholder("Topics")
        .setValue(this.folder)
        .onChange((value) => {
          this.folder = value;
        }));
    new Setting(this.contentEl)
      .addButton((button) => button
        .setButtonText("Create")
        .setCta()
        .onClick(() => this.create()))
      .addButton((button) => button.setButtonText("Cancel").onClick(() => this.close()));
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private async create(): Promise<void> {
    const title = this.title.trim();
    if (!title || title.includes("/") || title.endsWith(".md")) {
      new Notice("Enter a note title without slashes or the .md extension.");
      return;
    }
    try {
      const file = await this.host.createDashboardNote(
        title,
        normalizePath(this.folder.trim()),
        this.dashboard
      );
      this.close();
      openValuePicker(this.host, file, this.dashboard);
    } catch (error) {
      console.error("Property Logs: failed to create note", error);
      new Notice(error instanceof Error ? error.message : "Property Logs could not create the note.");
    }
  }
}

export class AddTopicModal extends Modal {
  constructor(
    app: App,
    private readonly host: TopicHost,
    private readonly dashboard: DashboardSettings
  ) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText("Add topic");
    this.contentEl.createEl("p", {
      text: `Add a note to ${this.dashboard.name}. Its scope rules still determine whether it appears.`,
      cls: "setting-item-description",
    });
    new Setting(this.contentEl)
      .setName("Pick existing note")
      .setDesc("Search notes that match this dashboard's scope.")
      .addButton((button) => button
        .setButtonText("Choose note")
        .setCta()
        .onClick(() => {
          this.close();
          new ExistingNoteModal(this.app, this.host, this.dashboard).open();
        }));
    new Setting(this.contentEl)
      .setName("New note")
      .setDesc("Create a Markdown file, then choose its initial value.")
      .addButton((button) => button.setButtonText("Create note").onClick(() => {
        this.close();
        new NewNoteModal(this.app, this.host, this.dashboard).open();
      }));
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
