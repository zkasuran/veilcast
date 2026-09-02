"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { type Call } from "starknet";
import styles from "../../../uni.module.css";
import { addrSTRK } from "@/utils/constants";
import { formatStrk, parseStrk } from "@/utils/veilcast";
import {
    type LevCoupon,
    type LevMarketView,
    type LevPosition,
    type Mandate,
    LEVERAGE_ONE,
    MAINTENANCE_MARGIN_BPS,
    MAX_LEVERAGE,
    SIDE_NO,
    SIDE_YES,
    addLiquidityCall,
    closeToWalletActions,
    createLevMarketCall,
    loadLevBoard,
    loadLevCoupons,
    loadMandate,
    loadPosition,
    loadVault,
    mandate as buildMandate,
    mandateStatus,
    markLevClosed,
    markLevOpened,
    markPosition,
    newLevCoupon,
    noMandate,
    openActions,
    priceBps,
    quoteOpen,
    removeLiquidityCall,
    saveLevCoupon,
} from "@/utils/leverage";
import SelectWallet from "../WalletHandle/SelectWallet";
import AmountInput from "../strk20/AmountInput";
import ResultCard from "../strk20/ResultCard";
import { type ActionResult, useStrk20 } from "../strk20/useStrk20";

type SubTab = "trade" | "positions" | "vault";

const SIDE_LABEL: Record<number, string> = { [SIDE_YES]: "YES", [SIDE_NO]: "NO" };

/// A price in basis points as a percent, "62.5%".
function pct(bps: number): string {
    return `${(bps / 100).toFixed(1)}%`;
}

/// The leverage of a coupon as "3.0x".
function leverageX(bps: number): string {
    return `${(bps / LEVERAGE_ONE).toFixed(1)}x`;
}
type Vault = { free: bigint; backing: bigint; insurance: bigint };
type Strk20 = ReturnType<typeof useStrk20>;

/// Leveraged, isolated-margin positions on a private FPMM book. Opening and closing route through
/// the STRK20 pool exactly like a bet, so the trader stays private; the loan, the liquidation and
/// the liquidity are public, because they are the market's plumbing rather than anyone's trade.
export default function LeveragePanel() {
    const strk20 = useStrk20();
    const [sub, setSub] = useState<SubTab>("trade");
    const [board, setBoard] = useState<LevMarketView[]>([]);
    const [vault, setVault] = useState<Vault | null>(null);
    const [loading, setLoading] = useState(false);
    const [refreshKey, setRefreshKey] = useState(0);

    const refresh = useCallback(() => setRefreshKey((n) => n + 1), []);

    useEffect(() => {
        if (!strk20.hasLeverage) {
            setBoard([]);
            setVault(null);
            return;
        }
        let live = true;
        setLoading(true);
        (async () => {
            try {
                const [markets, v] = await Promise.all([
                    loadLevBoard(strk20.provider, strk20.leverageAddress),
                    loadVault(strk20.provider, strk20.leverageAddress),
                ]);
                if (live) {
                    setBoard(markets);
                    setVault(v);
                }
            } catch {
                // A read failure leaves the last good board up rather than blanking the tab.
            } finally {
                if (live) setLoading(false);
            }
        })();
        return () => {
            live = false;
        };
    }, [strk20.hasLeverage, strk20.leverageAddress, strk20.providerIndex, refreshKey]);
    return (
        <div className={styles.panelWide}>
            <div className={styles.feeRow}>
                <span>Network</span>
                <span className={`${styles.feeVal} ${strk20.isStrk20Network ? styles.netOk : styles.netBad}`}>
                    <span
                        className={`${styles.netDot} ${strk20.isStrk20Network ? styles.netOkDot : styles.netBadDot}`}
                    />
                    {strk20.networkName ?? "Unsupported"}
                </span>
            </div>

            {!strk20.hasLeverage ? (
                <div className={styles.notice}>
                    The leveraged market is not deployed on {strk20.networkName ?? "this network"} yet. The parimutuel
                    board and the pool actions work here; leverage lights up once its contract is live.
                </div>
            ) : (
                <>
                    <div className={styles.chips}>
                        {(["trade", "positions", "vault"] as SubTab[]).map((key) => (
                            <button
                                key={key}
                                className={`${styles.chip} ${sub === key ? styles.chipActive : ""}`}
                                onClick={() => setSub(key)}
                            >
                                {key === "trade" ? "Trade" : key === "positions" ? "Positions" : "Liquidity"}
                            </button>
                        ))}
                    </div>

                    {sub === "trade" ? (
                        <TradeView board={board} loading={loading} strk20={strk20} onDone={refresh} />
                    ) : sub === "positions" ? (
                        <PositionsView board={board} strk20={strk20} onDone={refresh} />
                    ) : (
                        <VaultView vault={vault} strk20={strk20} onDone={refresh} />
                    )}
                </>
            )}
        </div>
    );
}

/// The trade form: pick a market and a side, post margin, choose leverage up to the 5x cap, and
/// open the position privately through the pool. The quote is computed the way `do_open` is, so the
/// number shown is the number booked.
function TradeView({
    board,
    loading,
    strk20,
    onDone,
}: {
    board: LevMarketView[];
    loading: boolean;
    strk20: Strk20;
    onDone: () => void;
}) {
    const [selectedId, setSelectedId] = useState<number | null>(null);
    const [side, setSide] = useState<number>(SIDE_YES);
    const [marginStr, setMarginStr] = useState("10");
    const [leverageBps, setLeverageBps] = useState(30_000);
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    // The mandate this position will carry. Off by default: delegation is opt-in per position and a
    // position opened without one can never be closed by anybody but its owner.
    const [delegating, setDelegating] = useState(false);
    const [agentKey, setAgentKey] = useState("");
    const [stopStr, setStopStr] = useState("3000");
    const [takeStr, setTakeStr] = useState("7000");

    const selected = useMemo(() => board.find((m) => m.id === selectedId) ?? board[0], [board, selectedId]);
    const margin = parseStrk(marginStr);
    const quote = useMemo(
        () => (selected && margin !== null ? quoteOpen(selected, side, margin, leverageBps) : null),
        [selected, side, margin, leverageBps]
    );

    // The payout address is always the connected wallet. Deliberately not editable: the whole safety
    // property is that the owner pins where the money lands, so letting an agent suggest it would give
    // away exactly what the mandate exists to withhold.
    const payoutTarget = strk20.address ?? "";

    // Build the mandate the same way the contract validates it, so a malformed one is refused here
    // rather than reverting on-chain and costing gas.
    const mandateOrError = useMemo((): { granted: Mandate } | { error: string } => {
        if (!delegating) return { granted: noMandate() };
        try {
            return {
                granted: buildMandate({
                    agentKey: agentKey.trim(),
                    stopPriceBps: Number(stopStr) || 0,
                    takePriceBps: Number(takeStr) || 0,
                    payoutTarget,
                }),
            };
        } catch (error) {
            return { error: (error as Error).message };
        }
    }, [delegating, agentKey, stopStr, takeStr, payoutTarget]);
    const granted = "granted" in mandateOrError ? mandateOrError.granted : null;

    async function open() {
        if (!selected || margin === null || granted === null) return;
        setResult(null);
        setBusy(true);
        try {
            // Saved before the wallet is touched: the key is the position and a tab that dies
            // mid-signature must not take the margin with it.
            const coupon = newLevCoupon(selected.id, side, margin, leverageBps);
            saveLevCoupon(coupon);
            // Guard the open against the book moving under it: allow 2% of slip past the quote.
            const maxPriceBps = quote ? Math.min(10_000, quote.priceAfterBps + 200) : 10_000;
            const txHash = await strk20.submit(
                openActions(addrSTRK, strk20.leverageAddress, coupon, maxPriceBps, granted),
                setResult,
                `${formatStrk(margin)} STRK at ${leverageX(leverageBps)} on ${SIDE_LABEL[side]}`
            );
            if (txHash) {
                markLevOpened(coupon.positionKey, txHash);
                onDone();
            }
        } finally {
            setBusy(false);
        }
    }

    if (loading && board.length === 0) return <div className={styles.notice}>Loading the leveraged board…</div>;
    if (board.length === 0)
        return (
            <div className={styles.notice}>
                No leveraged markets yet. Seed one from the Liquidity tab: provide vault collateral, then open a market
                for the AMM and a keeper to trade against.
            </div>
        );

    return (
        <div className={styles.panel}>
            <div className={styles.outcomes}>
                {board.map((m) => (
                    <button
                        key={m.id}
                        className={`${styles.marketCard} ${selected?.id === m.id ? styles.outcomeSelected : ""}`}
                        onClick={() => setSelectedId(m.id)}
                    >
                        <span className={styles.marketQuestion}>Market #{m.id}</span>
                        <span className={styles.subMono}>
                            YES {pct(priceBps(m.rYes, m.rNo))} · NO {pct(priceBps(m.rNo, m.rYes))}
                        </span>
                    </button>
                ))}
            </div>

            <div className={styles.chips}>
                {[SIDE_YES, SIDE_NO].map((s) => (
                    <button
                        key={s}
                        className={`${styles.chip} ${side === s ? styles.chipActive : ""}`}
                        onClick={() => setSide(s)}
                    >
                        Long {SIDE_LABEL[s]}
                    </button>
                ))}
            </div>

            <AmountInput
                label={`Margin on ${SIDE_LABEL[side]}`}
                value={marginStr}
                onChange={setMarginStr}
                hint={margin === null ? "Enter your margin in STRK" : `Isolated: ${formatStrk(margin)} STRK is the most you can lose`}
                detail={quote ? `${formatStrk(quote.notional)} STRK notional` : ""}
                disabled={busy}
            />

            <div className={styles.subLine}>
                <span>Leverage</span>
                <span className={styles.subMono}>{leverageX(leverageBps)}</span>
            </div>
            <input
                type="range"
                min={LEVERAGE_ONE}
                max={MAX_LEVERAGE}
                step={5_000}
                value={leverageBps}
                onChange={(e) => setLeverageBps(Number(e.target.value))}
                aria-label="Leverage"
                disabled={busy}
            />

            {quote ? (
                <div className={styles.factRows}>
                    <FactRow label="Notional" value={`${formatStrk(quote.notional)} STRK`} />
                    <FactRow label="Borrowed from vault" value={`${formatStrk(quote.borrowed)} STRK`} />
                    <FactRow label="Open fee (0.30%)" value={`${formatStrk(quote.fee)} STRK`} />
                    <FactRow label={`${SIDE_LABEL[side]} price`} value={`${pct(quote.entryPriceBps)} → ${pct(quote.priceAfterBps)}`} />
                    <FactRow label="Liquidated below" value={`${pct(MAINTENANCE_MARGIN_BPS)} health`} />
                </div>
            ) : null}

            <div className={styles.createBox}>
                <div className={styles.createHead}>
                    <label>
                        <input
                            type="checkbox"
                            checked={delegating}
                            onChange={(e) => setDelegating(e.target.checked)}
                            disabled={busy}
                        />{" "}
                        Let an agent close this for me
                    </label>
                </div>
                {delegating ? (
                    <>
                        <div className={styles.createNote}>
                            An agent can fire your stop or your take while you are offline. It cannot do anything else.
                            The payout address below is written into the position when it opens. The contract pays that
                            address on every agent close, so an agent can never send the money anywhere else. It also
                            cannot act until the market actually reaches one of your prices. Give it the agent&apos;s
                            public key only; it never needs your position key.
                        </div>
                        <input
                            className={styles.textInput}
                            value={agentKey}
                            onChange={(e) => setAgentKey(e.target.value)}
                            placeholder="Agent public key (run: veilcast-agent agent-key)"
                            aria-label="Agent public key"
                            spellCheck={false}
                            disabled={busy}
                        />
                        <div className={styles.subLine}>
                            <span>Stop below</span>
                            <span className={styles.subMono}>{pct(Number(stopStr) || 0)}</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={10_000}
                            step={100}
                            value={stopStr}
                            onChange={(e) => setStopStr(e.target.value)}
                            aria-label="Stop price"
                            disabled={busy}
                        />
                        <div className={styles.subLine}>
                            <span>Take above</span>
                            <span className={styles.subMono}>{pct(Number(takeStr) || 0)}</span>
                        </div>
                        <input
                            type="range"
                            min={0}
                            max={10_000}
                            step={100}
                            value={takeStr}
                            onChange={(e) => setTakeStr(e.target.value)}
                            aria-label="Take price"
                            disabled={busy}
                        />
                        <div className={styles.factRows}>
                            <FactRow
                                label="Pays only"
                                value={payoutTarget ? `${payoutTarget.slice(0, 10)}…${payoutTarget.slice(-4)}` : "connect a wallet"}
                            />
                            <FactRow
                                label="Agent may act"
                                value={
                                    (Number(stopStr) || 0) === 0 && (Number(takeStr) || 0) === 0
                                        ? "never (set a stop or a take)"
                                        : `at or below ${pct(Number(stopStr) || 0)}, at or above ${pct(Number(takeStr) || 0)}`
                                }
                            />
                            <FactRow label="Agent can never" value="redirect the payout or act outside the band" />
                        </div>
                        {"error" in mandateOrError ? <div className={styles.warn}>{mandateOrError.error}</div> : null}
                    </>
                ) : (
                    <div className={styles.createNote}>
                        Self-managed: only your coupon can close this position. Nobody else, including us, can.
                    </div>
                )}
            </div>

            <div className={styles.splitNote}>
                <span className={styles.splitPublic}>
                    Public: {margin === null ? "the margin" : `${formatStrk(margin)} STRK`} at {leverageX(leverageBps)} on{" "}
                    {SIDE_LABEL[side]}
                </span>
                <span className={styles.splitPrivate}>Private: that it is you</span>
            </div>

            {strk20.isConnected ? (
                <button
                    className={styles.btnCta}
                    disabled={margin === null || busy || granted === null}
                    onClick={open}
                >
                    {busy
                        ? "Proving and submitting…"
                        : delegating
                          ? "Open position with a mandate"
                          : "Open private position"}
                </button>
            ) : (
                <SelectWallet variant="ctaBig" />
            )}

            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}

/// One label/value line, reused across the quote, positions and vault.
function FactRow({ label, value }: { label: string; value: string }) {
    return (
        <div className={styles.factRow}>
            <span className={styles.factLabel}>{label}</span>
            <span className={styles.factValue}>{value}</span>
        </div>
    );
}

type Row = {
    coupon: LevCoupon;
    market: LevMarketView;
    position: LevPosition;
    mark: ReturnType<typeof markPosition>;
    /// The authority this position carries, read from chain rather than remembered locally, so what is
    /// shown is what the contract will actually enforce.
    mandate: Mandate;
    mandateStatus: ReturnType<typeof mandateStatus>;
};

/// The positions this browser holds a coupon for, marked live to the book. Closing pays the equity
/// straight to the connected wallet; the coupon signature names that address, so nobody else can
/// point the payout anywhere.
function PositionsView({ board, strk20, onDone }: { board: LevMarketView[]; strk20: Strk20; onDone: () => void }) {
    const [rows, setRows] = useState<Row[]>([]);
    const [busyKey, setBusyKey] = useState<string | null>(null);
    const [result, setResult] = useState<ActionResult | null>(null);
    const [reloadKey, setReloadKey] = useState(0);

    useEffect(() => {
        let live = true;
        (async () => {
            const coupons = loadLevCoupons().filter((c) => !c.closeTx);
            const loaded: Row[] = [];
            for (const coupon of coupons) {
                const market = board.find((m) => m.id === coupon.marketId);
                if (!market) continue;
                try {
                    const position = await loadPosition(
                        strk20.provider,
                        strk20.leverageAddress,
                        coupon.marketId,
                        coupon.side,
                        coupon.positionKey
                    );
                    if (position.state !== "Open") continue;
                    const held = await loadMandate(
                        strk20.provider,
                        strk20.leverageAddress,
                        coupon.marketId,
                        coupon.side,
                        coupon.positionKey
                    );
                    loaded.push({
                        coupon,
                        market,
                        position,
                        mark: markPosition(market, coupon.side, position),
                        mandate: held,
                        mandateStatus: mandateStatus(market, coupon.side, held),
                    });
                } catch {
                    // Skip a position that will not read rather than blanking the list.
                }
            }
            if (live) setRows(loaded);
        })();
        return () => {
            live = false;
        };
    }, [board, strk20.leverageAddress, strk20.providerIndex, reloadKey]);

    async function close(coupon: LevCoupon) {
        if (!strk20.address) return;
        setResult(null);
        setBusyKey(coupon.positionKey);
        try {
            const txHash = await strk20.submit(
                closeToWalletActions(strk20.leverageAddress, coupon, strk20.address),
                setResult,
                `Close ${SIDE_LABEL[coupon.side]} on market #${coupon.marketId}`
            );
            if (txHash) {
                markLevClosed(coupon.positionKey, txHash);
                setReloadKey((n) => n + 1);
                onDone();
            }
        } finally {
            setBusyKey(null);
        }
    }

    if (rows.length === 0)
        return (
            <div className={styles.notice}>
                No open leveraged positions in this browser. Open one from the Trade tab; the coupon that owns it is
                saved here and nowhere else.
            </div>
        );

    return (
        <div className={styles.panel}>
            {rows.map(({ coupon, position, mark, mandate: held, mandateStatus: status }) => {
                const neg = mark.pnl < 0n;
                const abs = neg ? -mark.pnl : mark.pnl;
                return (
                    <div key={coupon.positionKey} className={styles.positionRow}>
                        <div className={styles.positionHead}>
                            <span className={styles.positionQuestion}>
                                Market #{coupon.marketId} · Long {SIDE_LABEL[coupon.side]} · {leverageX(coupon.leverageBps)}
                            </span>
                        </div>
                        <div className={styles.factRows}>
                            <FactRow label="Margin" value={`${formatStrk(position.margin)} STRK`} />
                            <FactRow label="Notional" value={`${formatStrk(position.margin + position.borrowed)} STRK`} />
                            <FactRow label="Value now" value={`${formatStrk(mark.value)} STRK`} />
                            <FactRow label="P&L" value={`${neg ? "-" : "+"}${formatStrk(abs)} STRK`} />
                            <FactRow label="Health" value={pct(mark.healthBps)} />
                        </div>
                        {mark.liquidatable ? (
                            <div className={styles.warn}>Underwater: a keeper can liquidate this before you close it.</div>
                        ) : null}
                        {status.hasAgent ? (
                            <div className={styles.factRows}>
                                <FactRow
                                    label="Agent"
                                    value={`${held.agentKey.slice(0, 10)}…${held.agentKey.slice(-4)}`}
                                />
                                <FactRow
                                    label="May close"
                                    value={`${held.stopPriceBps > 0 ? `at or below ${pct(held.stopPriceBps)}` : "no stop"}, ${
                                        held.takePriceBps > 0 ? `at or above ${pct(held.takePriceBps)}` : "no take"
                                    }`}
                                />
                                <FactRow
                                    label="Pays only"
                                    value={`${held.payoutTarget.slice(0, 10)}…${held.payoutTarget.slice(-4)}`}
                                />
                                <FactRow label="Right now" value={status.reason} />
                            </div>
                        ) : (
                            <div className={styles.positionNote}>
                                Self-managed: only your coupon can close this.
                            </div>
                        )}
                        <div className={styles.positionActions}>
                            <button
                                className={styles.btnCta}
                                disabled={busyKey !== null || !strk20.isConnected}
                                onClick={() => close(coupon)}
                            >
                                {busyKey === coupon.positionKey ? "Closing…" : "Close to my wallet"}
                            </button>
                        </div>
                    </div>
                );
            })}
            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
// PLACEHOLDER_VIEWS

/// Provide or withdraw vault liquidity and seed a new leveraged market from it. The vault is the
/// counterparty every position borrows from; its free collateral caps the leverage it can lend, and
/// its insurance fund absorbs any bad debt a liquidation cannot cover.
function VaultView({ vault, strk20, onDone }: { vault: Vault | null; strk20: Strk20; onDone: () => void }) {
    const [mode, setMode] = useState<"add" | "remove">("add");
    const [amountStr, setAmountStr] = useState("100");
    const [result, setResult] = useState<ActionResult | null>(null);
    const [busy, setBusy] = useState(false);

    // The new-market form.
    const [days, setDays] = useState("7");
    const [seedStr, setSeedStr] = useState("50");
    const [creating, setCreating] = useState(false);

    const amount = parseStrk(amountStr);

    async function runLiquidity() {
        if (amount === null) return;
        setResult(null);
        setBusy(true);
        try {
            const calls: Call[] =
                mode === "add"
                    ? [
                          // Approve the contract to pull the STRK, then credit it to the vault.
                          {
                              contractAddress: addrSTRK,
                              entrypoint: "approve",
                              calldata: [strk20.leverageAddress, amount.toString(), "0"],
                          },
                          addLiquidityCall(strk20.leverageAddress, amount),
                      ]
                    : [removeLiquidityCall(strk20.leverageAddress, amount)];
            const txHash = await strk20.execute(
                calls,
                setResult,
                `${mode === "add" ? "Add" : "Remove"} ${formatStrk(amount)} ${mode === "add" ? "STRK" : "shares"}`
            );
            if (txHash) onDone();
        } finally {
            setBusy(false);
        }
    }

    async function createMarket() {
        const seed = parseStrk(seedStr);
        const dayCount = Number(days);
        if (seed === null || !Number.isFinite(dayCount) || dayCount <= 0 || !strk20.address) return;
        setResult(null);
        setCreating(true);
        try {
            const closeAt = Math.floor(Date.now() / 1000) + Math.round(dayCount * 86_400);
            const txHash = await strk20.execute(
                [createLevMarketCall(strk20.leverageAddress, strk20.address, closeAt, seed)],
                setResult,
                `New market, ${formatStrk(seed)} STRK seed`
            );
            if (txHash) onDone();
        } finally {
            setCreating(false);
        }
    }

    return (
        <div className={styles.panel}>
            <div className={styles.factRows}>
                <FactRow label="Free to lend" value={vault ? `${formatStrk(vault.free)} STRK` : "…"} />
                <FactRow label="Committed as backing" value={vault ? `${formatStrk(vault.backing)} STRK` : "…"} />
                <FactRow label="Insurance fund" value={vault ? `${formatStrk(vault.insurance)} STRK` : "…"} />
            </div>

            <div className={styles.chips}>
                {(["add", "remove"] as const).map((m) => (
                    <button
                        key={m}
                        className={`${styles.chip} ${mode === m ? styles.chipActive : ""}`}
                        onClick={() => setMode(m)}
                    >
                        {m === "add" ? "Add liquidity" : "Remove"}
                    </button>
                ))}
            </div>

            <AmountInput
                label={mode === "add" ? "Provide to the vault" : "Burn vault shares"}
                value={amountStr}
                onChange={setAmountStr}
                hint={mode === "add" ? "You earn a share of the vault and cover the borrow it lends" : "Redeem shares for free vault collateral"}
                detail={amount === null ? "" : `${formatStrk(amount)} ${mode === "add" ? "STRK" : "shares"}`}
                disabled={busy}
            />

            {strk20.isConnected ? (
                <button className={styles.btnCta} disabled={amount === null || busy} onClick={runLiquidity}>
                    {busy ? "Submitting…" : mode === "add" ? "Add liquidity" : "Remove liquidity"}
                </button>
            ) : (
                <SelectWallet variant="ctaBig" />
            )}

            <div className={styles.createBox}>
                <div className={styles.createHead}>Open a leveraged market</div>
                <div className={styles.createNote}>
                    Seeds an even 50/50 book from the vault. You are its resolver: settle it on the winning side after
                    the close. You can also void it to refund every margin.
                </div>
                <input
                    className={styles.textInput}
                    value={days}
                    onChange={(e) => setDays(e.target.value)}
                    inputMode="decimal"
                    aria-label="Days until close"
                    placeholder="Days until close"
                />
                <AmountInput
                    label="Seed from vault"
                    value={seedStr}
                    onChange={setSeedStr}
                    hint="AMM depth for the new book, drawn from free vault collateral"
                    detail=""
                    disabled={creating}
                />
                {strk20.isConnected ? (
                    <button className={styles.btn} disabled={creating} onClick={createMarket}>
                        {creating ? "Creating…" : "Create market"}
                    </button>
                ) : null}
            </div>

            {result ? <ResultCard result={result} providerIndex={strk20.providerIndex} /> : null}
        </div>
    );
}
