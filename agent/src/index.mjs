/// The public API of the veilcast-agent runtime.
///
/// Import this to drive Veilcast from a program; use the CLI for a shell or an LLM tool call. Both go
/// through the same functions, so nothing is reachable one way and not the other.
///
/// What an agent can do here and what it structurally cannot:
/// - It CAN read everything: markets, prices, positions, mandates, vault solvency, its own balances.
/// - It CAN quote and plan for free, with maths that matches the contract felt for felt.
/// - It CAN fire a mandate it was granted, inside the price band, paying the address the owner pinned
///   on-chain at open.
/// - It CAN liquidate any position that has fallen to the maintenance floor and earn the keeper fee.
/// - It CANNOT redirect a payout, widen its own authority, act outside its band, close a self-managed
///   position or spend an owner's position. None of that is policy in this file; all of it is
///   enforced by cairo/src/leveraged_market.cairo, which is why the agent key is safe to hand out.

export { MAINNET, RISK, ENV_KEYS, resolveConfig, isDeployed } from "./config.mjs";
export { EXIT, ok, fail, emit, note, feltError, FELT_HINTS } from "./result.mjs";
export {
    paths,
    ensureAgentKey,
    readAgentKey,
    agentPublicKey,
    assertNotOwnerKey,
    viewingKey,
    loadFundingAccount,
    readState,
    writeState,
} from "./keys.mjs";
export {
    isqrt,
    priceBps,
    buy,
    sell,
    sidesOf,
    quoteOpen,
    markPosition,
    mandateStatus,
    keeperReward,
    sharePrice,
    lpResult,
    formatStrk,
    parseStrk,
} from "./pricing.mjs";
export {
    SIDE_YES,
    SIDE_NO,
    CLAIM_MESSAGE_TAG,
    CLOSE_MESSAGE_TAG,
    newCoupon,
    claimMessageHash,
    closeMessageHash,
    betCalldata,
    claimIntoNoteCalldata,
    claimToAddressCalldata,
    openCalldata,
    noMandate,
    mandate,
    closeToAddressCalldata,
    closeIntoNoteCalldata,
    agentCloseCalldata,
    signWith,
} from "./calldata.mjs";
export {
    rpc,
    callView,
    SELECTORS,
    proveBlock,
    tokenBalance,
    levMarketCount,
    levMarket,
    levBoard,
    levPosition,
    levMandate,
    vaultState,
    openedPositions,
    receiptFacts,
    countsUnderProgramRule,
    quoteRemoveLiquidity,
    vaultShares,
    liquidityHistory,
    classHashAt,
} from "./chain.mjs";
export {
    loadPrivacySdk,
    openSession,
    submitProved,
    approvePool,
    shield,
    poolBet,
    poolOpen,
    poolInvoke,
    notes,
    waitForNote,
} from "./pool.mjs";
export {
    feeOn,
    impliedProbability,
    settledPayout,
    quotePayout,
    payoutMultiple,
    positionStatus,
    decodeMarketViews,
    board,
    market,
    stakeOf,
    betHistory,
    DEPLOYED_AT,
} from "./market.mjs";
export { scanKeeper, scanMandates } from "./scan.mjs";
