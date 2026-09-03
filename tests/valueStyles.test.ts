import { strict as assert } from "node:assert";
import { test } from "node:test";

import {
  globalLevelMapping,
  knownValues,
  normalizeGlobalValueStyles,
  resolveValueColors,
} from "../data/valueStyles";

test("global value styles reject unusable levels and colors", () => {
  const styles = normalizeGlobalValueStyles({
    Active: { level: 3, color: "palette:green" },
    Blocked: { level: 9, color: "chartreuse" },
    "": { level: 1 },
    Broken: "nope",
  });

  assert.deepEqual(Object.keys(styles), ["Active", "Blocked"]);
  assert.equal(styles.Blocked.level, null);
  assert.equal(styles.Blocked.color, "palette:blue");
  assert.deepEqual(globalLevelMapping(styles), { Active: 3 });
});

test("dashboard colors override the vault-wide ones", () => {
  const styles = normalizeGlobalValueStyles({
    Active: { level: 3, color: "palette:green" },
    Paused: { level: 1, color: "palette:amber" },
  });
  const colors = resolveValueColors(styles, { Paused: "palette:red" });

  assert.equal(colors.Active, "palette:green");
  assert.equal(colors.Paused, "palette:red");
});

test("known values merge global styles with dashboard mappings", () => {
  const styles = normalizeGlobalValueStyles({ Active: { level: 3, color: "palette:green" } });
  assert.deepEqual(knownValues(styles, { Done: 4 }, { Paused: "palette:red" }), [
    "Active",
    "Done",
    "Paused",
  ]);
});
