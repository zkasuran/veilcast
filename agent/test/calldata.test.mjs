/// Tests for calldata layouts and the close signature.
///
/// These are the vectors that keep four independent implementations in agreement: the Cairo contract,
/// the SDK, the app and this runtime. The close-message hash is asserted against the same hardcoded
/// felt the Cairo suite asserts in `test_close_message_hash_matches_the_frontend`, so a drift in any
/// layer fails here rather than reverting a live transaction.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ec, num } from "starknet";
import {
    CLAIM_MESSAGE_TAG,
    CLOSE_MESSAGE_TAG,
    agentCloseCalldata,
    betCalldata,
    claimMessageHash,
    closeIntoNoteCalldata,
    closeMessageHash,
    closeToAddressCalldata,
    mandate,
    newCoupon,
    noMandate,
    openCalldata,
    signWith,
} from "../src/calldata.mjs";
import { assertNotOwnerKey, viewingKey } from "../src/keys.mjs";
import { feltError, FELT_HINTS } from "../src/result.mjs";

const LEV = "0x4c4556"; // "LEV"
const MARKET = "0x4d41524b4554"; // "MARKET"
const PRIVATE_KEY = "0x1234";
const POSITION_KEY = "0x434f55504f4e"; // "COUPON"
const ONE = 10n ** 18n;

test("the domain separators match the Cairo constants", () => {
    // VEILCAST_CLAIM in market.cairo and VEILCAST_LEVCLOSE in leverage_interface.cairo.
    assert.equal(CLAIM_MESSAGE_TAG, "0x5645494c434153545f434c41494d");
    assert.equal(CLOSE_MESSAGE_TAG, "0x5645494c434153545f4c4556434c4f5345");
});

test("closeMessageHash agrees with the contract, the SDK and the app, felt for felt", () => {
    // The vector pinned in cairo/src/tests/test_leverage.cairo, sdk/src/leverage.test.ts and
    // src/utils/leverage.test.ts. Four implementations, one number.
    assert.equal(
        closeMessageHash(LEV, 7, 1, POSITION_KEY, "0x0"),
        "0x1b63599a3692bd03b2fb7691332e685cffb4bb5217293a435bf23f2c4790e8e"
    );
});

test("claimMessageHash agrees with the market contract's pinned vector", () => {
    assert.equal(
        claimMessageHash(MARKET, 7, 1, POSITION_KEY, "0x0"),
        "0x421e0ee22d66877400410f3d00e57cae3b41f27c631bb8315168ac53a23ddf6"
    );
});

test("the close hash is bound to its target, so a signature cannot be redirected", () => {
    const toNote = closeMessageHash(LEV, 7, 1, POSITION_KEY, "0x0");
    const toAddress = closeMessageHash(LEV, 7, 1, POSITION_KEY, "0xabc");
    const toOther = closeMessageHash(LEV, 7, 1, POSITION_KEY, "0xdef");
    assert.notEqual(toNote, toAddress);
    assert.notEqual(toAddress, toOther);
});

test("the close hash is bound to the market and the side", () => {
    const base = closeMessageHash(LEV, 7, 1, POSITION_KEY, "0x0");
    assert.notEqual(base, closeMessageHash(LEV, 8, 1, POSITION_KEY, "0x0"));
    assert.notEqual(base, closeMessageHash(LEV, 7, 0, POSITION_KEY, "0x0"));
    // And to the contract, so a signature for one deployment is useless on another.
    assert.notEqual(base, closeMessageHash("0x4c4557", 7, 1, POSITION_KEY, "0x0"));
});

test("betCalldata lays out the Bet variant of MarketAction", () => {
    const calldata = betCalldata({ marketId: 7, outcome: 1, amount: 2n * ONE, positionKey: POSITION_KEY });
    assert.deepEqual(calldata, ["0x0", "0x7", "0x1", "0x1bc16d674ec80000", POSITION_KEY]);
});

test("openCalldata lays out the Open variant with the mandate inline", () => {
    const granted = mandate({ agentKey: "0xa9e", stopPriceBps: 4000, takePriceBps: 8000, payoutTarget: "0xbeef" });
    const calldata = openCalldata({
        marketId: 7,
        side: 0,
        positionKey: POSITION_KEY,
        margin: 2n * ONE,
        leverageBps: 30_000,
        maxPriceBps: 6000,
        mandate: granted,
    });
    // [0, market, side, key, margin, leverage, maxPrice, agentKey, stop, take, payoutTarget]
    assert.equal(calldata.length, 11);
    assert.deepEqual(calldata, [
        "0x0",
        "0x7",
        "0x0",
        POSITION_KEY,
        "0x1bc16d674ec80000",
        "0x7530",
        "0x1770",
        "0xa9e",
        "0xfa0",
        "0x1f40",
        "0xbeef",
    ]);
});

test("a self-managed open carries a zeroed mandate, which no agent can ever fire", () => {
    const calldata = openCalldata({
        marketId: 0,
        side: 0,
        positionKey: POSITION_KEY,
        margin: ONE,
        leverageBps: 20_000,
    });
    assert.deepEqual(calldata.slice(-4), ["0x0", "0x0", "0x0", "0x0"]);
    assert.deepEqual(noMandate(), { agentKey: "0x0", stopPriceBps: 0, takePriceBps: 0, payoutTarget: "0x0" });
});

test("mandate() refuses every malformed authority the contract would refuse", () => {
    assert.throws(() => mandate({ agentKey: "0x0", stopPriceBps: 1, payoutTarget: "0xbeef" }), /needs an agent key/);
    assert.throws(
        () => mandate({ agentKey: "0xa9e", stopPriceBps: 1, payoutTarget: "0x0" }),
        /must pin a payout address/
    );
    // No band at all would be an unconditional authority, which the contract rejects as BAD_MANDATE.
    assert.throws(() => mandate({ agentKey: "0xa9e", payoutTarget: "0xbeef" }), /must grant a stop or a take/);
    // Bands are basis points of probability, so anything outside [0, 10000] is nonsense.
    assert.throws(
        () => mandate({ agentKey: "0xa9e", stopPriceBps: 10_001, payoutTarget: "0xbeef" }),
        /stopPriceBps must be an integer/
    );
    assert.throws(
        () => mandate({ agentKey: "0xa9e", takePriceBps: -1, payoutTarget: "0xbeef" }),
        /takePriceBps must be an integer/
    );
});

test("a mandate that grants only one half is valid, because the other is opt-out", () => {
    assert.doesNotThrow(() => mandate({ agentKey: "0xa9e", stopPriceBps: 4000, payoutTarget: "0xbeef" }));
    assert.doesNotThrow(() => mandate({ agentKey: "0xa9e", takePriceBps: 8000, payoutTarget: "0xbeef" }));
});

test("an owner close to an address signs over that address", () => {
    const calldata = closeToAddressCalldata({
        levAddress: LEV,
        marketId: 7,
        side: 1,
        privateKey: PRIVATE_KEY,
        positionKey: POSITION_KEY,
        recipient: "0xabc",
    });
    const expected = signWith(PRIVATE_KEY, closeMessageHash(LEV, 7, 1, POSITION_KEY, "0xabc"));
    assert.deepEqual(calldata, ["0x1", "0x7", "0x1", POSITION_KEY, expected.r, expected.s, "0x1", "0xabc"]);
});

test("an owner close into a note signs a zero target, which is a bearer authorization", () => {
    const calldata = closeIntoNoteCalldata({
        levAddress: LEV,
        marketId: 7,
        side: 1,
        privateKey: PRIVATE_KEY,
        positionKey: POSITION_KEY,
        noteId: 3,
    });
    const expected = signWith(PRIVATE_KEY, closeMessageHash(LEV, 7, 1, POSITION_KEY, "0x0"));
    assert.deepEqual(calldata, ["0x1", "0x7", "0x1", POSITION_KEY, expected.r, expected.s, "0x0", "0x3"]);
});

test("an agent close names no target and no terms: it is only a request to act now", () => {
    const calldata = agentCloseCalldata({
        levAddress: LEV,
        marketId: 7,
        side: 0,
        positionKey: POSITION_KEY,
        agentPrivateKey: PRIVATE_KEY,
        payoutTarget: "0xbeef",
    });
    // [2, market, side, key, r, s]. Six felts: no target, no band, nothing the agent chose.
    assert.equal(calldata.length, 6);
    assert.equal(calldata[0], "0x2");
    const expected = signWith(PRIVATE_KEY, closeMessageHash(LEV, 7, 0, POSITION_KEY, "0xbeef"));
    assert.equal(calldata[4], expected.r);
    assert.equal(calldata[5], expected.s);
});

test("the agent signs over the pinned target, so signing another one produces a different signature", () => {
    const pinned = agentCloseCalldata({
        levAddress: LEV,
        marketId: 7,
        side: 0,
        positionKey: POSITION_KEY,
        agentPrivateKey: PRIVATE_KEY,
        payoutTarget: "0xbeef",
    });
    const attackerTarget = agentCloseCalldata({
        levAddress: LEV,
        marketId: 7,
        side: 0,
        positionKey: POSITION_KEY,
        agentPrivateKey: PRIVATE_KEY,
        payoutTarget: "0xa77ac4e5",
    });
    // Both are well-formed, but only the one over the stored target verifies on-chain. That is the
    // whole reason an agent cannot redirect a payout: the contract reads the target, not this input.
    assert.notEqual(pinned[4], attackerTarget[4]);
});

test("an owner signature and an agent signature over the same close are different", () => {
    const ownerSig = signWith(PRIVATE_KEY, closeMessageHash(LEV, 7, 0, POSITION_KEY, "0xbeef"));
    const agentSig = signWith("0x5678", closeMessageHash(LEV, 7, 0, POSITION_KEY, "0xbeef"));
    assert.notEqual(ownerSig.r, agentSig.r);
});

test("newCoupon mints an unlinkable bearer position key", () => {
    const first = newCoupon();
    const second = newCoupon();
    assert.equal(first.positionKey, ec.starkCurve.getStarkKey(first.privateKey));
    assert.notEqual(first.privateKey, second.privateKey);
    assert.notEqual(first.positionKey, second.positionKey);
});

test("the viewing key is canonical, which the prover requires", () => {
    const order = ec.starkCurve.CURVE.n;
    for (const key of ["0x1", "0x1234", "0xdeadbeef", num.toHex(order - 1n)]) {
        const derived = viewingKey(key);
        assert.ok(derived > 0n, "never zero");
        assert.ok(derived < order / 2n, "must be below n/2 or the prover returns PRIVATE_KEY_NOT_CANONICAL");
    }
});

test("assertNotOwnerKey refuses a private key by proving its public half owns a position", async () => {
    // The check has to be sound rather than shape-based, because a private key and a public key are
    // both field elements and nothing about the bytes distinguishes them. So it derives the public half
    // and asks whether THAT owns a position; only a private key has a public half that owns something.
    const ownerPrivate = "0x1234";
    const ownerPublic = ec.starkCurve.getStarkKey(ownerPrivate);
    const ownsPosition = async (derived) => BigInt(derived) === BigInt(ownerPublic);

    await assert.rejects(
        () => assertNotOwnerKey(ownerPrivate, ownsPosition, "--key"),
        /is an owner position PRIVATE key/
    );

    // The public key itself must pass: it is exactly what these commands are meant to take and it is
    // not a secret. A shape-based guard would have wrongly rejected this.
    await assert.doesNotReject(() => assertNotOwnerKey(ownerPublic, ownsPosition, "--key"));

    // A long random felt that owns nothing is not evidence of anything, so it passes.
    await assert.doesNotReject(() => assertNotOwnerKey("0x" + "a".repeat(60), ownsPosition, "--key"));
    // Non-hex and missing values are simply not checkable.
    await assert.doesNotReject(() => assertNotOwnerKey(undefined, ownsPosition, "--key"));
    await assert.doesNotReject(() => assertNotOwnerKey("not-a-felt", ownsPosition, "--key"));
    // A failing lookup must not block a legitimate call: the contract is the real guard.
    await assert.doesNotReject(() =>
        assertNotOwnerKey(ownerPrivate, async () => {
            throw new Error("rpc down");
        }, "--key")
    );
});

test("feltError recovers the Cairo reason from a revert and every reason has a hint", () => {
    // A reverted Starknet call reports panic data as hex felts inside a long message.
    const asciiToFelt = (text) =>
        `0x${[...text].map((character) => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
    for (const reason of ["MANDATE_NOT_MET", "NO_MANDATE", "BAD_CLOSE_SIGNATURE", "HEALTHY", "SLIPPAGE"]) {
        const message = `execution reverted: Error in the called contract: ${asciiToFelt(reason)} tail`;
        assert.equal(feltError(new Error(message)), reason, `should decode ${reason}`);
        assert.ok(FELT_HINTS[reason], `${reason} needs an actionable hint`);
    }
    assert.equal(feltError(new Error("no felts here")), undefined);
});
