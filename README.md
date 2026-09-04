# Property Logs

An [Obsidian](https://obsidian.md) plugin that automatically logs property changes in frontmatter with timestamps. Track status updates, deadline changes, priority shifts, and any other property mutations to build a rich audit trail for your notes.

## Features

- **Automatic property tracking** — Watch any frontmatter property for changes and automatically log them to a history array with timestamps
- **Flexible filtering** — Include/exclude specific folders and tags to control which notes are tracked
- **Smart deduplication** — Optionally skip logging duplicate status values or overwrite same-day entries
- **Comments** — Add timestamped comments to notes to annotate status history
- **Daily note logging** — Mirror property changes into your daily note using tag-based templates, so you can see at a glance what moved each day
- **Visual status charts** — Insert interactive charts that visualize how status evolved over time across multiple notes (requires [Dataview](https://github.com/blacksmithgu/obsidian-dataview) and [Obsidian Charts](https://github.com/phibr0/obsidian-charts))
- **Timeline dashboards** — Create saved, interactive date-axis dashboards with independent scope, grouping, sorting, colors, and click-to-update bars
- **Embedded dashboards** — Drop a dashboard into any note with a `property-logs` code block; inside a periodic note it centers on that note's date and zooms to match the note type
- **Periodic-note integration** — Clickable day, week, month, quarter, and year cells open the matching note through [Journals](https://github.com/srg-kostyrko/obsidian-journals), with week numbers and dividers on the axis
- **Notes from your journal** — Marked task lines such as `- [n] Felt good about this` appear on the timeline for that note's date, with a per-marker icon and color
- **Foldable rows** — Collapse a status or group row into a single line carrying one count per day
- **Global value styles** — Set a level and color once per property value; any dashboard can override them
- **Customizable keys** — Rename the history key and property names to match your vault's naming conventions
- **Multiple tracked properties** — Go beyond status—track deadline changes, priority updates, assignees, or any other property

## Use Cases

### Project & Task Management
- **Track project status evolution** — See how a project moved from Planned → Active → Completed with exact dates
- **Monitor milestone deadlines** — Log when deadlines shift, detect scope creep
- **Visualize team capacity** — Chart how many projects were Active, In Progress, or Blocked each month

### Content Management
- **Publishing workflow** — Track Draft → Review → Scheduled → Published with timestamps
- **Content priority tracking** — Monitor how content priorities changed before publication
- **Audience reach visualization** — Chart how many articles were Featured vs. Archived each period

### Knowledge Management
- **Note maturity tracking** — Watch notes progress from Seedling → Growing → Evergreen
- **Research status** — Monitor whether research topics are Exploring, Consolidating, or Complete
- **Learning progress** — Chart concept mastery levels over time

### OKR & Goal Tracking
- **Goal progress** — Log goal status changes (Planning → Active → Achieved → Archived)
- **Quarterly performance** — Visualize OKR completion rates per quarter
- **Initiative tracking** — Monitor initiatives across pipeline stages

### General Audit Trails
- **Change history** — Maintain a full audit trail of any property that matters to you
- **Decision documentation** — Log when decisions change status with optional comments
- **Compliance** — Create timestamped records of status/property changes for audit purposes

## How It Works

The plugin monitors your vault's metadata cache. When a property in a watched note changes, it automatically appends an entry to a configurable history array in the note's frontmatter. Only changes are logged—the first time a property is seen, it becomes the baseline.

### Example

A note with `status` changes might look like this:

```yaml
---
title: Launch new website
status: Active
color: blue
status_history:
  - dateSet: "2025-01-15"
    statusSet: Backlog
  - dateSet: "2025-02-20"
    statusSet: Active
---
```

If you track additional properties (e.g., `deadline`), changed values appear in the same history entry:

```yaml
---
title: Launch new website
status: Active
deadline: "2025-04-30"
status_history:
  - dateSet: "2025-01-15"
    statusSet: Backlog
  - dateSet: "2025-02-20"
    statusSet: Active
    deadlineSet: "2025-04-30"
  - dateSet: "2025-02-28"
    comment: "Deadline extended due to scope changes"
    deadlineSet: "2025-05-15"
---
```

## Installation

1. Download `main.js` and `manifest.json` from the [latest release](https://github.com/connradolisboa/status-logger/releases)
2. Create a folder `.obsidian/plugins/property-logs/` in your vault
3. Place both files in that folder
4. Reload Obsidian or restart it
5. Go to **Settings → Community Plugins** and enable **Property Logs**

Alternatively, install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) (Obsidian plugin manager):

1. Install BRAT and enable it
2. Add the repository: `https://github.com/connradolisboa/status-logger`
3. Enable **Property Logs** in Community Plugins

## Configuration

### Settings Overview

Open **Settings → Property Logs** to configure six tabs: Filters, Behavior, Daily Note Log, Dashboards, Values, and Periodic Notes.

#### Filters Tab

Control which notes the plugin monitors:

| Setting | Description |
|---------|-------------|
| **Included Folders** | Only track files in these folders. Leave empty to track all (unless excluded). You can specify paths like `Projects` or `Projects/Active`. |
| **Included Tags** | Only track files with these tags. Leave empty to track all (unless excluded). Tags are specified without the `#` symbol (e.g., `tracked`, `monitored`). |
| **Excluded Folders** | Never track files in these folders. Exclusions take priority over inclusions. |
| **Excluded Tags** | Never track files with these tags. Exclusions take priority over inclusions. |

**Examples:**
- Track only files in the `Projects` folder: Add `Projects` to Included Folders
- Track all files except archive: Add `Archive` to Excluded Folders
- Track files tagged with `tracked` and `important`: Add both to Included Tags
- Track everything except files tagged `no-log`: Add `no-log` to Excluded Tags

#### Behavior Tab

Customize logging behavior and property names.

##### Logging Options

| Setting | Description |
|---------|-------------|
| **Overwrite same-day entries** | When enabled, only the latest change per day is kept (older changes the same day are replaced). Useful to avoid cluttering history with minor adjustments. |
| **Skip duplicate status** | When enabled, a status change is not logged if it matches the most recent entry. Prevents logging redundant state transitions. |

##### Property Keys

Customize the frontmatter keys used in history entries:

| Setting | Default | Description |
|---------|---------|-------------|
| **History key** | `property_history` | The frontmatter array where all history entries are stored |
| **Date key** | `dateSet` | The field name used for the date within each history entry |
| **Status key** | `statusSet` | The field name used for the status value within each history entry |

Change these if your vault uses different naming conventions (e.g., use `timestamp` instead of `dateSet`).

##### Additional Tracked Properties

Beyond status, track any other frontmatter property. Specify:
- **Frontmatter key** — The property name in your note (e.g., `deadline`, `priority`, `assignee`)
- **History key** — The key to use in history entries (e.g., `deadlineSet`, `prioritySet`)

**Example:** To track deadline changes alongside status:
- Add Frontmatter key: `deadline`
- Add History key: `deadlineSet`

When the `deadline` property changes, it appears in the history entry:
```yaml
- dateSet: "2025-02-28"
  deadlineSet: "2025-05-15"
  comment: "Deadline extended"
```

#### Daily Note Log Tab

Mirror tracked property changes into your daily note. When a watched property changes on a file, a configurable line is appended to today's daily note — useful for skimming what moved each day without opening every project.

| Setting | Description |
|---------|-------------|
| **Enable daily note logging** | Master switch for the feature |
| **Folder (fallback)** | Folder where daily notes live. Used only if the core Daily Notes plugin is disabled |
| **Date format (fallback)** | Moment.js format for the daily-note filename (e.g. `YYYY-MM-DD`). Falls back to this only if the core Daily Notes plugin is disabled |
| **Heading (optional)** | If set, entries are inserted under this heading (e.g. `## Status Changes`). The heading is created if missing. Leave empty to append at the end of the note |

If the core **Daily Notes** plugin is enabled, its folder and date format are used automatically — the fallback values only apply when it's disabled.

##### Log Groups

Each group routes notes tagged with a given tag to a specific log template. The first group whose tag matches the changed note wins. If no group matches, nothing is logged.

| Field | Description |
|-------|-------------|
| **Tag** | Tag (without `#`) that the source note must carry to use this group |
| **Watched keys** | Optional comma-separated list of keys to log. Leave empty to log every tracked change. Switch between matching by frontmatter key (e.g. `status`) or history key (e.g. `statusSet`) |
| **Template** | The line written to the daily note. Supports placeholders: `{{link}}`, `{{name}}`, `{{path}}`, `{{key}}`, `{{from}}`, `{{to}}`, `{{date}}`, `{{time}}` |

**Example template:**

```
- {{time}} {{link}} — {{key}}: {{from}} → {{to}}
```

When the `status` on a note tagged `project` flips from `Backlog` to `Active`, the daily note gets:

```
- 14:32 [[Launch new website]] — status: Backlog → Active
```

#### Chart Defaults Tab

Pre-fill defaults when inserting charts. These are automatically updated each time you insert a chart with custom parameters.

| Setting | Description |
|---------|-------------|
| **Default folder** | Folder path to filter pages by (e.g., `Projects`) |
| **Default tags** | Tags to filter pages by, comma-separated without `#` (e.g., `area, project`) |
| **Default period** | Time interval for chart X-axis: Week, Month, Quarter, or Year |
| **Default start date** | Start of the date range (`YYYY-MM-DD` format) |
| **Default end date** | End of the date range (`YYYY-MM-DD` format) |

#### Dashboards Tab

Create one or more saved timeline dashboards. Each dashboard has independent configuration for:

| Setting | Description |
|---------|-------------|
| **Tracked property** | Live frontmatter property that determines the displayed level. Its configured history key is used when available; otherwise Property Logs uses `{property}Set`. |
| **Value mapping** | Maps known property values to levels 0–4. Level 0 always hides that portion of the timeline. |
| **Unset and unmapped levels** | Controls notes without tracked history and free-text values that are not in the map. |
| **Color mode** | Colors bars by level or by another frontmatter property. |
| **Scope** | Includes or excludes folders, tags, and property rules for this dashboard only. Exclusions take priority. |
| **Row properties** | Current frontmatter values or latest history-entry values displayed beside each note title. |
| **Group and sort defaults** | Starts with folder, level, alphabetical, recently changed, or any selected frontmatter property. |

Clicking a note on the timeline opens a value picker. Choosing a mapped value or entering free text updates both the note's live property and its existing history array. Choosing a value mapped to level 0 hides the new segment without deleting history.

## Commands

The plugin adds five commands (accessible via Ctrl/Cmd+P command palette):

### Open Timeline Dashboard

Opens a saved Property Logs timeline. If more than one dashboard exists, a fuzzy picker lets you choose one. The same action is available from the ribbon.

From the dashboard you can:

- Group and sort rows without leaving the view
- Switch between level and property coloring
- Open a note from its row label
- Click a note to update the tracked value
- Add an eligible existing note or create a new note and set its initial value

The timeline uses the bundled `vis-timeline` renderer; no companion plugin is required.

### Insert Dashboard Embed

Inserts a `property-logs` code block at the cursor. See [Embedding a dashboard](#embedding-a-dashboard).

### Duplicate Dashboard

Copies a dashboard — scope, mappings, colors, and layout — under a new name and opens the copy. The same action is available from the Dashboards settings tab and from the dashboard's overflow menu.

### Insert Status Chart

Opens a modal to configure and insert a dataviewjs chart block.

**Parameters:**
- **Folder** — Filter pages by vault folder path (e.g., `Projects`). Leave blank for all folders.
- **Tags** — Filter pages by tags, comma-separated without `#` (e.g., `area, project`). Leave blank for all tags.
- **Period** — Time interval for the X-axis: Week, Month, Quarter, or Year
- **Start date** — Start of the date range (`YYYY-MM-DD`)
- **End date** — End of the date range (`YYYY-MM-DD`)

The chart is inserted as a dataviewjs code block at your cursor position.

**Requirements:** [Dataview](https://github.com/blacksmithgu/obsidian-dataview) and [Obsidian Charts](https://github.com/phibr0/obsidian-charts) must be installed and enabled.

### Add Comment to Note

Opens a modal to add a timestamped comment to the current note's history.

Comments are logged to the same history entry as status changes on the same day (or create a new entry if no status change occurred). Useful for annotating why a status changed or adding context to a property change.

## Embedding a dashboard

Add a code block to any note:

````markdown
```property-logs
dashboard: Topics
date: auto
zoom: auto
```
````

| Option | Default | Description |
|--------|---------|-------------|
| `dashboard` | first dashboard | Dashboard name or id |
| `date` | `auto` | `auto` uses the host note's own period; `today` or a `YYYY-MM-DD` date pins the embed |
| `period` | `auto` | Forces `day`, `week`, `month`, `quarter`, or `year` instead of the note's own type |
| `zoom` | `auto` | Visible span such as `30d`, `6w`, `3m`, or `1y`. `auto` uses the span configured for the note type |
| `height` | `420` | Maximum height in pixels |
| `header` | `true` | Shows the slim header with the dashboard name, period, and zoom controls |
| `minimal` | `false` | Hides the header/zoom controls and shrinks rows, text, and spacing for a low-profile embed |

In a periodic note the embed centers on that note's date and zooms to match its type: a daily note shows a few weeks, a monthly note shows a couple of quarters. Spans per note type are configured in the Periodic Notes tab, and `zoom:` overrides them for a single block.

Because the embed reads the period from the note the block is rendered for, it also works with [Virtual Content](https://github.com/Signynt/virtual-footer): put the code block in a Virtual Content rule for your daily notes and every daily note gets a dashboard centered on its own date without touching the files.

An embed holds the space it will take and builds itself as you scroll near it, so a note carrying several of them opens at once and nothing shifts underneath as each one fills in.

## Periodic Notes and Journals

With the [Journals](https://github.com/srg-kostyrko/obsidian-journals) plugin installed, the calendar axis above the timeline is clickable:

- Day cells open the daily note
- Week cells (labelled with the ISO week number) open the weekly note
- Month, quarter, and year cells open their notes

Journals creates the note if it does not exist yet. Without Journals, day cells fall back to the core Daily Notes plugin and the other levels report that no journal is configured. Week dividers follow the week start configured in the Periodic Notes tab.

### Notes from periodic notes

A task line in a periodic note becomes a note on the timeline at that note's date:

```markdown
- [n] Today I've been feeling well about this
- [!] Deployment slipped again
- [?] Is the new scope realistic
```

Each marker gets its own icon and color, configured in the Periodic Notes tab, which start out as `n` (note), `!` (important), `?` (question), `i` (info), `*` (highlight), and `b` (bookmark). Markers use Obsidian's checkbox syntax, so the same characters your theme styles as custom checkboxes work here, and the rendered note carries a `data-task` attribute for further styling. Plain `- [ ]` and `- [x]` lines are ignored.

Notes are truncated on the timeline and show the full text on hover; clicking one opens the source note on that line. Editing a periodic note leaves open dashboards alone until the typing pauses, and only redraws them when a marked line or a tracked property actually changed. If the line links to a note that has its own row — `- [n] [[Project Atlas]] shipped the beta` — the note attaches to that row instead of the shared journal lane; while that row is folded it goes back to the lane, since a folded row has no space to draw it.

## How a note is drawn

A note is its name in small type and a hairline in the note's colour running to the end of the period. How that line ends says whether the value did: an arrowhead means the note still holds it, an upright bar means it stopped there. Names are clipped rather than wrapped, so several notes read side by side across the same week, and names that would collide stack, so a row grows only as far as its notes need. Hovering a name grows it back to a readable size with the row properties it carries; a hint with the note name, its value, its dates, and those properties follows shortly after.

## Folding rows

Every group header carries a fold toggle. Folding collapses the rows underneath into a single line, which keeps a long dashboard readable while still showing where the activity is. Fold state is saved per dashboard, and the overflow menu can fold or unfold everything at once.

A folded row draws no notes. It carries one number per day instead — how many of that group's notes sit on that day — and hovering a number names them, along with the value each one held. Every count stays on the one line, so days that crowd together at a wide zoom overlap rather than growing the row back.

The shared journal lane folds the same way, and its counts land in each day's own column rather than in the label: folded, the label keeps only its marker icon.

## Global value styles

The **Values** tab sets a level and color per property value for the whole vault, so `Active` means the same thing on every dashboard. A dashboard's own value mapping or color always overrides the global one, and the "Tracked value" color mode colors bars by the value itself rather than by level.

## Mobile

Dashboards and embeds adapt to narrow screens: the toolbar wraps and scrolls, rows and labels shrink, and controls use touch-sized targets. On mobile, tapping a journal note opens a menu with the full text and a link to the source note, since there is no hover. Full-tab dashboards support pinch-to-zoom; embedded dashboards stay still so the note keeps scrolling normally, and their header buttons handle zooming.

## Supported Status Values

The chart recognizes these standard status values. They map to numeric levels for visualization:

| Status | Level | Appearance |
|--------|-------|------------|
| Inactive, New, Cancelled | 1 | Circle marker |
| Backlog | 2 | — |
| Ongoing | 3 | — |
| Active | 4 | — |
| Done | 5 | — |

Use any other status values; they'll appear as blank on the chart but are still logged in history.

## Chart Behavior

- **Multi-line visualization** — Each note becomes a line on the chart, colored by its `color` frontmatter field
- **Supported colors** — Todoist color names (e.g., `blue`, `green`, `grape`, `red`, `orange`) or hex codes (e.g., `#FF5733`)
- **Baseline value** — Notes with no history yet show as `Inactive`
- **Future periods** — Notes created after a period's end don't appear for earlier periods
- **Shape markers** — Special point shapes distinguish Inactive (●), New (▲), and Cancelled (✕)
- **Time spanning** — Chart spans entire date range even if some notes have no data

## Examples

### Example 1: Track Project Status

Set up tracking for projects in the `Projects` folder:

1. Add `Projects` to **Included Folders** in settings
2. Add a `status` field to project notes: `status: Backlog`
3. Change the status as work progresses → The plugin logs each change automatically
4. Run **Insert Status Chart** and filter by folder `Projects` to visualize progress

### Example 2: Track Multiple Properties

Monitor both status and deadline for tasks:

1. In **Additional Tracked Properties**, add:
   - Frontmatter key: `deadline` → History key: `deadlineSet`
   - Frontmatter key: `priority` → History key: `prioritySet`
2. Add to your notes:
   ```yaml
   status: Backlog
   deadline: "2025-04-30"
   priority: P2
   ```
3. When either `deadline` or `priority` changes, both appear in the history:
   ```yaml
   - dateSet: "2025-02-28"
     statusSet: Active
     deadlineSet: "2025-05-15"
     prioritySet: P1
   ```

### Example 3: Selective Tracking

Track all project notes except archived ones:

1. Add `Projects` to **Included Folders**
2. Add `Archive` to **Excluded Folders**
3. Now only active project notes in `Projects` are tracked (excluding `Projects/Archive`)

### Example 4: Tag-Based Tracking

Track only notes tagged with `tracked`:

1. Add `tracked` to **Included Tags**
2. Leave folders empty
3. Only notes with the `tracked` tag will be monitored

Add the tag to any note you want to monitor, regardless of folder.

## Tips & Tricks

- **Separate concerns** — Use included folders for broad scoping (e.g., all projects) and tags for fine-grained control (e.g., only "high-visibility" projects)
- **Comments for context** — Use "Add comment to note" to annotate why a status changed for later review
- **Consolidate same-day changes** — Enable "Overwrite same-day entries" if you frequently adjust properties and only care about the final state per day
- **Chart filtering** — Always check the chart command's folder/tags to ensure you're visualizing the right subset of notes
- **Baseline stability** — The first time a property is seen becomes the baseline (not logged). Subsequent changes are logged. This prevents spurious entries when enabling tracking on an existing note

## How It Compares

| Feature | Property Logs | Obsidian Dataview | Obsidian Tasks |
|---------|---------------|-------------------|-----------------|
| Auto-log property changes | ✓ | ✗ | ✗ |
| Track any property | ✓ | ✗ | Partial |
| History per note | ✓ | ✗ | ✗ |
| Status timeline charts | ✓ | Manual queries | Task-only |
| Comments in history | ✓ | ✗ | ✗ |
| Configurable filtering | ✓ | ✓ | ✗ |

## Limitations

- Charts require [Dataview](https://github.com/blacksmithgu/obsidian-dataview) and [Obsidian Charts](https://github.com/phibr0/obsidian-charts) plugins
- Status values outside the standard set (Inactive, Backlog, Ongoing, Active, Done, etc.) won't be charted but are still logged
- Charts don't currently support filtering by multiple status values simultaneously
- Property changes are logged based on metadata cache updates; changes not reflected in the cache may not be detected

## Technical Details

- **Non-destructive** — All frontmatter edits use Obsidian's `processFrontMatter` API
- **Persistent state** — Baseline property values are saved to plugin data, so tracking state survives vault restarts
- **Metadata cache** — The plugin listens to metadata cache changes, so updates are instant within Obsidian
- **No external APIs** — All logging and charting happens locally in your vault

## Support

Found a bug or have a feature request? Open an issue on [GitHub](https://github.com/connradolisboa/status-logger/issues).

## License

ISC
