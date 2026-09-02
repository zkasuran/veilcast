/// The program's eligibility rule, tested in isolation.
///
/// This decides whether our submission clears its bar, so it is worth pinning rather than trusting one
/// live run. The rule: the transaction must have succeeded, the pool must have emitted an event in it,
/// and if the submission lists contracts of its own then one of those must have emitted an event too.
/// The last clause is the one that is easy to get wrong, because it means listing a contract raises our
/// own bar: a plain shield through the pool stops counting the moment we claim a contract.

import { strict as assert } from "node:assert";
import test from "node:test";
import { countsUnderProgramRule } from "../src/chain.mjs";

const shield = { succeeded: true, poolEvent: true, contractEvent: false };
const bet = { succeeded: true, poolEvent: true, contractEvent: true };

test("a pool action that carries one of our events counts", () => {
    assert.equal(countsUnderProgramRule(bet, true), true);
});

test("a pool-only action does not count once we claim a contract", () => {
    // The shield is a real, successful pool transaction. It still does not count, because touching the
    // pool without touching our code is the pool running rather than us.
    assert.equal(countsUnderProgramRule(shield, true), false);
});

test("a pool-only action counts when the submission claims no contracts", () => {
    assert.equal(countsUnderProgramRule(shield, false), true);
});

test("a reverted transaction never counts, whatever it emitted", () => {
    assert.equal(countsUnderProgramRule({ ...bet, succeeded: false }, true), false);
    assert.equal(countsUnderProgramRule({ ...bet, succeeded: false }, false), false);
});

test("an action that misses the pool never counts", () => {
    // Creating a market is our contract emitting on its own. Useful, but not a pool transaction.
    const createMarket = { succeeded: true, poolEvent: false, contractEvent: true };
    assert.equal(countsUnderProgramRule(createMarket, true), false);
});

test("a missing or malformed receipt does not count rather than throwing", () => {
    // `verify` walks a list of hashes and one bad hash must not take the whole report down.
    assert.equal(countsUnderProgramRule(null, true), false);
    assert.equal(countsUnderProgramRule(undefined, false), false);
    assert.equal(countsUnderProgramRule({}, true), false);
});

test("contractEvent must be truthy, not merely present", () => {
    // receiptFacts omits contractEvent entirely when nothing was claimed, so undefined has to fail the
    // claimed-contracts branch rather than pass it.
    assert.equal(countsUnderProgramRule({ succeeded: true, poolEvent: true }, true), false);
});
