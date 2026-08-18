import { shortString } from "starknet";
import { describe, expect, it } from "vitest";
import {
    VOID_CHOICE,
    decodeCommittee,
    isAddress,
    openCommitteeMarketCall,
    parseJurors,
    voteCall,
} from "./committee";

const RESOLVER = "0x0c033";
const ALICE = "0x0a11ce";
const BOB = "0x0b0b";
const CAROL = "0x0ca401";

describe("committee calls", () => {
    it("encodes open_committee_market with the panel and quorum", () => {
        expect(
            openCommitteeMarketCall(
                RESOLVER,
                "Did the home team win?",
                ["Yes", "No"],
                1000,
                "Sports",
                0,
                [ALICE, BOB, CAROL],
                2
            )
        ).toEqual({
            contractAddress: RESOLVER,
            entrypoint: "open_committee_market",
            calldata: [
                // question, then a label per side
                "0", "25595849797417580497976735060656937973250002361347647", "22",
                "2", "0", "5858675", "3", "0", "20079", "2",
                "1000",
                // 'Sports', a zero fee, then the three jurors and the quorum
                "91742371214451", "0",
                "3", "659918", "2827", "828417",
                "2",
            ],
        });
    });

    it("encodes a vote, and a void vote, as just the id and the choice", () => {
        expect(voteCall(RESOLVER, 7, 1).calldata).toEqual(["7", "1"]);
        expect(voteCall(RESOLVER, 7, VOID_CHOICE).calldata).toEqual(["7", "255"]);
    });
});

describe("decodeCommittee", () => {
    it("reads a bound panel", () => {
        expect(
            decodeCommittee({ n_jurors: 3n, quorum: 2n, n_outcomes: 2n, close_at: 1000n, decided: false })
        ).toEqual({ nJurors: 3, quorum: 2, nOutcomes: 2, closeAt: 1000, decided: false });
    });
});

describe("parseJurors", () => {
    it("splits on newlines or commas, keeps order, drops duplicates and blanks", () => {
        const { jurors, invalid } = parseJurors(`${ALICE}\n${BOB} , ${CAROL}\n\n${ALICE}`);
        expect(jurors).toEqual([ALICE, BOB, CAROL]);
        expect(invalid).toEqual([]);
    });

    it("dedupes on address value, not on the string typed", () => {
        // The same address, padded and unpadded, is one juror.
        const { jurors } = parseJurors("0x00a11ce\n0xa11ce");
        expect(jurors).toHaveLength(1);
    });

    it("collects anything that is not an address rather than silently dropping it", () => {
        const { jurors, invalid } = parseJurors(`${ALICE}\nnot-an-address\n0x0`);
        expect(jurors).toEqual([ALICE]);
        expect(invalid).toEqual(["not-an-address", "0x0"]);
    });

    it("knows a usable address from a zero or junk one", () => {
        expect(isAddress(ALICE)).toBe(true);
        expect(isAddress("0x0")).toBe(false);
        expect(isAddress("")).toBe(false);
        expect(isAddress("hello")).toBe(false);
    });
});

// A sanity check that the fixture question encodes the way the calldata test above expects.
it("question fixture matches", () => {
    expect(shortString.encodeShortString("Sports")).toBe("0x53706f727473");
});
