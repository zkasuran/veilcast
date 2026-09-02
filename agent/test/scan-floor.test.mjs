/// Event scans must never start at genesis.
///
/// A public Starknet RPC answers a from_block-0 range with an *empty page* rather than an error, so a
/// scanner that starts there reports zero results and looks correct while being completely blind. This
/// cost the same bug twice: once on the parimutuel bet history, then again on the leveraged position scan
/// the day the contract deployed, where keeper-scan reported 0 open positions with one open on chain.

import { strict as assert } from "node:assert";
import test from "node:test";
import { MAINNET, resolveConfig } from "../src/config.mjs";

test("mainnet carries a deploy block for each contract that has an event log", () => {
    assert.ok(MAINNET.marketFromBlock > 0, "the parimutuel market needs a scan floor");
    assert.ok(MAINNET.leverageFromBlock > 0, "the leveraged market needs a scan floor");
});

test("the floors survive resolveConfig, because that is what the readers are handed", () => {
    const config = resolveConfig({}, {});
    assert.equal(config.leverageFromBlock, MAINNET.leverageFromBlock);
    assert.equal(config.marketFromBlock, MAINNET.marketFromBlock);
});

test("the leverage floor is at or after the market's, since it deployed later", () => {
    // Not a law of nature, but true here. A floor accidentally set to the wrong contract's block would
    // scan a range that cannot contain the events being looked for.
    assert.ok(MAINNET.leverageFromBlock >= MAINNET.marketFromBlock);
});

test("an override is honoured, so a fork or a redeploy does not need a release", () => {
    const config = resolveConfig({ leverageFromBlock: 42 }, {});
    assert.equal(config.leverageFromBlock, 42);
});
