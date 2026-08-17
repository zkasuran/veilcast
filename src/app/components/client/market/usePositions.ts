"use client";

import { useCallback, useEffect, useState } from "react";
import { loadStake } from "@/utils/market";
import { type Coupon, loadCoupons } from "@/utils/veilcast";
import { errorMessage, useStrk20 } from "../strk20/useStrk20";

/// The coupons this browser holds, with the stake the chain still shows for each.
///
/// Pass a market id to narrow it to one market's positions. Reading the stake per coupon is the only
/// way to know a position was already collected, because nothing on-chain links a position to an
/// account this app could ask about.
export function usePositions(marketId?: number) {
    const strk20 = useStrk20();
    const { provider, marketAddress, hasMarket } = strk20;
    const [coupons, setCoupons] = useState<Coupon[]>([]);
    const [stakes, setStakes] = useState<Record<string, bigint>>({});
    const [error, setError] = useState("");

    const reload = useCallback(() => {
        const held = loadCoupons();
        setCoupons(marketId === undefined ? held : held.filter((coupon) => coupon.marketId === marketId));
    }, [marketId]);

    useEffect(() => {
        reload();
    }, [reload]);

    const readStakes = useCallback(async () => {
        if (!hasMarket || coupons.length === 0) return;
        try {
            const pairs = await Promise.all(
                coupons.map(
                    async (coupon) =>
                        [
                            coupon.positionKey,
                            await loadStake(
                                provider,
                                marketAddress,
                                coupon.marketId,
                                coupon.outcome,
                                coupon.positionKey
                            ),
                        ] as const
                )
            );
            setStakes(Object.fromEntries(pairs));
            setError("");
        } catch (failure) {
            setError(`Could not read positions from the chain: ${errorMessage(failure)}`);
        }
    }, [coupons, hasMarket, marketAddress, provider]);

    useEffect(() => {
        void readStakes();
    }, [readStakes]);

    /// The stake to show for a coupon: what the chain says, or what the coupon claims until the
    /// chain has answered.
    function stakeOf(coupon: Coupon): bigint {
        return stakes[coupon.positionKey] ?? BigInt(coupon.amount);
    }

    return { coupons, stakes, stakeOf, error, reload };
}
