import { ec } from "starknet";
import { describe, expect, it } from "vitest";
import {
    type SealedEnvelope,
    decodeTicket,
    encodeTicket,
    isSealedEnvelope,
    seal,
    unseal,
} from "./vault";
import type { Coupon } from "./veilcast";

const PRIVATE_KEY = "0x1234";

function coupon(overrides: Partial<Coupon> = {}): Coupon {
    return {
        marketId: 7,
        outcome: 1,
        privateKey: PRIVATE_KEY,
        positionKey: ec.starkCurve.getStarkKey(PRIVATE_KEY),
        amount: (2n * 10n ** 18n).toString(),
        createdAt: 123,
        ...overrides,
    };
}

const deriveKey = (privateKey: string) => ec.starkCurve.getStarkKey(privateKey);

describe("seal / unseal", () => {
    it("round-trips a payload through a passphrase", async () => {
        const sealed = await seal("the whole vault", "correct horse", "vault");
        expect(sealed.kind).toBe("vault");
        expect(sealed.ct).not.toContain("the whole vault");
        expect(await unseal(sealed, "correct horse")).toBe("the whole vault");
    });

    it("refuses the wrong passphrase, and cannot tell tampering from it", async () => {
        const sealed = await seal("secret", "right", "ticket");
        await expect(unseal(sealed, "wrong")).rejects.toThrow("WRONG_PASSPHRASE");
        const tampered: SealedEnvelope = { ...sealed, ct: sealed.ct.slice(0, -4) + "AAAA" };
        await expect(unseal(tampered, "right")).rejects.toThrow("WRONG_PASSPHRASE");
    });

    it("uses a fresh salt and iv each time, so the same input seals differently", async () => {
        const a = await seal("same", "pass", "vault");
        const b = await seal("same", "pass", "vault");
        expect(a.ct).not.toBe(b.ct);
        expect(a.salt).not.toBe(b.salt);
        expect(await unseal(a, "pass")).toBe("same");
        expect(await unseal(b, "pass")).toBe("same");
    });

    it("recognises its own envelopes and nothing else", () => {
        expect(isSealedEnvelope({ v: 1, kind: "vault", salt: "a", iv: "b", ct: "c" })).toBe(true);
        expect(isSealedEnvelope({ coupons: [] })).toBe(false);
        expect(isSealedEnvelope("veilcast:abc")).toBe(false);
    });
});

describe("bearer tickets", () => {
    it("round-trips one coupon, recomputing the public key rather than trusting it", () => {
        const original = coupon();
        const ticket = encodeTicket(original);
        expect(ticket.startsWith("veilcast:")).toBe(true);
        // The private key is enough; the ticket never carries the public half.
        expect(ticket).not.toContain(original.positionKey.slice(2));

        const restored = decodeTicket(ticket, deriveKey);
        expect(restored?.marketId).toBe(original.marketId);
        expect(restored?.outcome).toBe(original.outcome);
        expect(restored?.privateKey).toBe(original.privateKey);
        expect(restored?.amount).toBe(original.amount);
        // Derived, so it always matches the private key it came with.
        expect(restored?.positionKey).toBe(original.positionKey);
    });

    it("returns null for anything that is not a Veilcast ticket", () => {
        expect(decodeTicket("hello", deriveKey)).toBeNull();
        expect(decodeTicket("veilcast:not-base64!!", deriveKey)).toBeNull();
        expect(decodeTicket("veilcast:" + btoa('{"v":2}'), deriveKey)).toBeNull();
    });

    it("can be locked behind a passphrase and read back", async () => {
        const ticket = encodeTicket(coupon());
        const sealed = await seal(ticket, "hand-off", "ticket");
        const opened = await unseal(sealed, "hand-off");
        expect(decodeTicket(opened, deriveKey)?.privateKey).toBe(PRIVATE_KEY);
    });
});
