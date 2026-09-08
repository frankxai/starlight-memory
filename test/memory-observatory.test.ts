/**
 * The observatory is the registry the Queen recommends from. gbrain is an
 * opt-in accelerator that is frequently absent, so these tests pin the two
 * properties that keep it from quietly becoming load-bearing: it is registered,
 * and it can never be handed back as a recommended default.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { REGISTRY, recommend } from "../tools/memory-observatory.mjs";

const REQ = {
  ram: 32,
  sovereignty: "high",
  privacy: "high",
  crossDevice: true,
  theoryOfMind: true,
  budget: "low",
};

describe("memory observatory registry", () => {
  it("registers the gbrain adapter that src/gbrain-provider.ts implements", () => {
    const gbrain = REGISTRY.find((s) => s.id === "gbrain");
    assert.ok(gbrain, "gbrain adapter exists in src/ but is missing from the registry");
    assert.equal(gbrain.role, "recall-accelerator");
    assert.equal(gbrain.adapter, "yes");
  });

  it("marks gbrain optional so an absent brain is a supported state", () => {
    assert.equal(REGISTRY.find((s) => s.id === "gbrain").optional, true);
  });

  it("never recommends an optional accelerator as a default slot", () => {
    const r = recommend(REQ);
    for (const slot of ["recall", "peer", "mirror"] as const) {
      assert.notEqual(
        r[slot]?.id,
        "gbrain",
        `gbrain filled the "${slot}" slot; a recommended default must not depend on a tool that may be offline`,
      );
    }
  });

  it("still ranks gbrain so it stays discoverable", () => {
    assert.ok(recommend(REQ).ranked.some((s) => s.id === "gbrain"));
  });

  it("keeps local_core the only authority", () => {
    const authorities = REGISTRY.filter((s) => s.role === "authority");
    assert.equal(authorities.length, 1);
    assert.equal(authorities[0].id, "local-core");
    assert.equal(recommend(REQ).authority.id, "local-core");
  });

  it("still fills the recall slot when optional entries are excluded", () => {
    const r = recommend(REQ);
    assert.ok(r.recall, "excluding optional accelerators must not empty the recall slot");
    assert.equal(r.recall.role, "recall-accelerator");
  });
});
