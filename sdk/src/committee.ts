import { Contract, num, type Abi, type Call, type ProviderInterface } from "starknet";
import { COMMITTEE_RESOLVER_ABI } from "./abi.js";
import { encodeCategory } from "./constants.js";

/// The committee resolver: a market settled by a vote of named jurors, for questions no feed can
/// answer. The first choice to reach the quorum settles it, void included. No casting vote, no admin.

/// The choice a juror casts to void rather than settle on an outcome, matching `VOID_CHOICE`.
export const VOID_CHOICE = 255;
/// Most jurors a panel can seat, matching `MAX_JURORS`.
export const MAX_JURORS = 16;

/// The panel bound to a market. `nJurors === 0` means this resolver never opened the market.
export type Committee = {
    nJurors: number;
    quorum: number;
    nOutcomes: number;
    closeAt: number;
    decided: boolean;
};

export type Ballot = { juror: string; isJuror: boolean; hasVoted: boolean; choice: number };

export function committeeContract(address: string, provider?: ProviderInterface): Contract {
    return new Contract({ abi: COMMITTEE_RESOLVER_ABI as Abi, address, providerOrAccount: provider });
}

/// Opens a market judged by `jurors`, needing `quorum` of them to agree. The opener is the fee
/// recipient, because the resolver contract cannot hold a balance to pay one out.
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
    const committee: Committee = {
        nJurors: Number(raw.n_jurors),
        quorum: Number(raw.quorum),
        nOutcomes: Number(raw.n_outcomes),
        closeAt: Number(raw.close_at),
        decided: Boolean(raw.decided),
    };
    return committee.nJurors === 0 ? undefined : committee;
}

/// The votes each outcome has, plus the void tally.
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
    return { juror: account, isJuror: Boolean(isJuror), hasVoted: Boolean(hasVoted), choice: Number(choice) };
}

/// Splits a list of addresses (newlines or commas) into a clean list, in order, without duplicates
/// or blanks. The contract rejects a duplicate juror, so catching it here saves a reverted call.
export function parseJurors(text: string): { jurors: string[]; invalid: string[] } {
    const seen = new Set<string>();
    const jurors: string[] = [];
    const invalid: string[] = [];
    for (const token of text.split(/[\s,]+/).map((entry) => entry.trim()).filter(Boolean)) {
        let value: bigint;
        try {
            value = num.toBigInt(token);
        } catch {
            invalid.push(token);
            continue;
        }
        if (value === 0n) {
            invalid.push(token);
            continue;
        }
        const key = value.toString();
        if (seen.has(key)) continue;
        seen.add(key);
        jurors.push(token);
    }
    return { jurors, invalid };
}
