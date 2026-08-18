"use client";

import { Contract, num, type Abi, type Call, type ProviderInterface } from "starknet";
import committeeAbi from "@/abi/committeeResolver.json";
import { encodeCategory } from "./discovery";

const ABI = committeeAbi as Abi;

/// The choice a juror casts to void a market rather than settle it on an outcome, matching
/// `VOID_CHOICE` in cairo/src/committee_resolver.cairo. A vote is one `u8`, so void has to be a
/// value no real outcome can take, and a market caps out at eight outcomes.
export const VOID_CHOICE = 255;

/// Most jurors a panel can seat, matching `MAX_JURORS`. A bettor should be able to read the whole
/// jury before staking, so the panel is kept small.
export const MAX_JURORS = 16;

/// The panel bound to a market, decoded from `get_committee`. `nJurors === 0` means this resolver
/// never opened the market, which is how "not a committee market" reads back.
export type Committee = {
    nJurors: number;
    quorum: number;
    nOutcomes: number;
    closeAt: number;
    decided: boolean;
};

/// Where a juror stands on a market, for the panel a voter sees.
export type Ballot = {
    juror: string;
    isJuror: boolean;
    hasVoted: boolean;
    /// The choice they cast, once `hasVoted`. `VOID_CHOICE` for a void vote.
    choice: number;
};

export function committeeContract(address: string, provider?: ProviderInterface): Contract {
    return new Contract({ abi: ABI, address, providerOrAccount: provider });
}

/// Opens a market judged by `jurors`, needing `quorum` of them to agree. The opener is the fee
/// recipient, because the resolver contract cannot hold a balance to pay one out itself.
export function openCommitteeMarketCall(
    address: string,
    question: string,
    labels: string[],
    closeAt: number,
    category: string,
    feeBps: number,
    jurors: string[],
    quorum: number
): Call {
    return committeeContract(address).populate("open_committee_market", [
        question,
        labels,
        closeAt,
        encodeCategory(category),
        feeBps,
        jurors,
        quorum,
    ]);
}

/// Casts the caller's vote. `choice` is an outcome index, or `VOID_CHOICE` to cancel.
export function voteCall(address: string, marketId: number, choice: number): Call {
    return committeeContract(address).populate("vote", [marketId, choice]);
}

export function decodeCommittee(raw: {
    n_jurors: bigint;
    quorum: bigint;
    n_outcomes: bigint;
    close_at: bigint;
    decided: boolean;
}): Committee {
    return {
        nJurors: Number(raw.n_jurors),
        quorum: Number(raw.quorum),
        nOutcomes: Number(raw.n_outcomes),
        closeAt: Number(raw.close_at),
        decided: Boolean(raw.decided),
    };
}

/// The committee a market is bound to, or undefined if this resolver never opened it.
export async function loadCommittee(
    provider: ProviderInterface,
    address: string,
    marketId: number
): Promise<Committee | undefined> {
    const raw = (await committeeContract(address, provider).call("get_committee", [marketId])) as {
        n_jurors: bigint;
        quorum: bigint;
        n_outcomes: bigint;
        close_at: bigint;
        decided: boolean;
    };
    const committee = decodeCommittee(raw);
    return committee.nJurors === 0 ? undefined : committee;
}

/// The votes each choice has, plus a void tally, so a panel can be shown at a glance. Index `i` is
/// outcome `i`; the last entry is the void tally.
export async function loadTally(
    provider: ProviderInterface,
    address: string,
    marketId: number,
    nOutcomes: number
): Promise<{ perOutcome: number[]; void: number }> {
    const contract = committeeContract(address, provider);
    const perOutcome = await Promise.all(
        Array.from({ length: nOutcomes }, async (_unused, outcome) =>
            Number((await contract.call("get_votes", [marketId, outcome])) as bigint)
        )
    );
    const voidVotes = Number((await contract.call("get_votes", [marketId, VOID_CHOICE])) as bigint);
    return { perOutcome, void: voidVotes };
}

/// Where one account stands on a market: whether it is on the panel and how it voted.
export async function loadBallot(
    provider: ProviderInterface,
    address: string,
    marketId: number,
    account: string
): Promise<Ballot> {
    const contract = committeeContract(address, provider);
    const [isJuror, hasVoted, choice] = await Promise.all([
        contract.call("is_juror", [marketId, account]) as Promise<boolean>,
        contract.call("has_voted", [marketId, account]) as Promise<boolean>,
        contract.call("vote_of", [marketId, account]) as Promise<bigint>,
    ]);
    return {
        juror: account,
        isJuror: Boolean(isJuror),
        hasVoted: Boolean(hasVoted),
        choice: Number(choice),
    };
}

/// Whether an address string is a usable, non-zero Starknet address.
export function isAddress(value: string): boolean {
    try {
        return num.toBigInt(value.trim()) !== 0n;
    } catch {
        return false;
    }
}

/// Splits a textarea of addresses (newlines or commas) into a clean list, in the order typed and
/// with duplicates and blanks dropped. The contract rejects a duplicate juror, so catching it here
/// saves a reverted transaction.
export function parseJurors(text: string): { jurors: string[]; invalid: string[] } {
    const seen = new Set<string>();
    const jurors: string[] = [];
    const invalid: string[] = [];
    for (const token of text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean)) {
        if (!isAddress(token)) {
            invalid.push(token);
            continue;
        }
        const key = num.toBigInt(token).toString();
        if (seen.has(key)) continue;
        seen.add(key);
        jurors.push(token);
    }
    return { jurors, invalid };
}
