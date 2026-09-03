import { App, FuzzySuggestModal } from "obsidian";

import type { DashboardSettings } from "../data/dashboard";

export interface DashboardOpener {
  app: App;
  getDashboards(): DashboardSettings[];
  openDashboard(id: string): Promise<void>;
}

export class DashboardPickerModal extends FuzzySuggestModal<DashboardSettings> {
  constructor(
    app: App,
    private readonly host: DashboardOpener,
    placeholder = "Open Property Logs dashboard"
  ) {
    super(app);
    this.setPlaceholder(placeholder);
  }

  getItems(): DashboardSettings[] {
    return this.host.getDashboards();
  }

  getItemText(dashboard: DashboardSettings): string {
    return dashboard.name;
  }

  onChooseItem(dashboard: DashboardSettings): void {
    void this.host.openDashboard(dashboard.id);
  }
}
