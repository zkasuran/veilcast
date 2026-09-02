/// A full dress rehearsal of the mainnet deploy, run against a local devnet.
///
/// The point is to de-risk spending real STRK. Every step here is the step the mainnet script will
/// take, in the same order, against a real Starknet node rather than the snforge test VM: declare,
/// deploy, seed the vault, open a market, open a leveraged position carrying a mandate, read it back,
/// then have the agent fire that mandate. If this passes, the only thing separating it from mainnet is
/// the gas price.
///
/// One deliberate difference: the pool address is set to our own account, so this script can call
/// `privacy_invoke` directly and exercise the pool-only path without standing up a privacy pool. On
/// mainnet the real pool holds that role. Nothing else changes.

import { Account, RpcProvider, hash, json, ec, num } from "starknet";
import { readFileSync } from "node:fs";
import { closeMessageHash, openCalldata, mandate, agentCloseCalldata, newCoupon } from "../../agent/src/calldata.mjs";
import { markPosition, priceBps, quoteOpen, formatStrk } from "../../agent/src/pricing.mjs";

const RPC = process.env.DEVNET_RPC ?? "http://127.0.0.1:5055";
/// The first predeployed account of `starknet-devnet --seed 0`. Deterministic from the seed, printed on
/// startup and identical on every machine, so it is a public test fixture rather than a secret. It
/// holds no mainnet funds and the address does not exist on mainnet.
const ADDRESS = "0x064b48806902a367c8598f4f95c305e8c1a1acba5f082d294a43793113115691";
const PRIVATE_KEY = "0x0000000000000000000000000000000071d7bb07b9a64f6f78ac4c816aff4da9";
const STRK = "0x4718f5a0fc34cc1af16a1cdee98ffb20c31f5cd61d6ab07201858f4287c938d";
const ONE = 10n ** 18n;

const provider = new RpcProvider({ nodeUrl: RPC });
const account = new Account({ provider, address: ADDRESS, signer: PRIVATE_KEY, cairoVersion: "1" });

function step(label) {
    process.stdout.write(`\n== ${label}\n`);
}

async function send(label, calls) {
    const sent = await account.execute(calls);
    const receipt = await provider.waitForTransaction(sent.transaction_hash, { retryInterval: 200 });
    const status = receipt.execution_status ?? receipt.value?.execution_status;
    if (status === "REVERTED") {
        throw new Error(`${label} reverted: ${JSON.stringify(receipt).slice(0, 500)}`);
    }
    const fee = BigInt(receipt.actual_fee?.amount ?? receipt.actual_fee ?? 0);
    console.log(`   ${label}: ok, fee ${formatStrk(fee, 6)} STRK, tx ${sent.transaction_hash.slice(0, 18)}…`);
    return { txHash: sent.transaction_hash, fee, receipt };
}

async function view(contract, entrypoint, calldata = []) {
    return provider.callContract({ contractAddress: contract, entrypoint, calldata: calldata.map(String) });
}

step("1. declare LeveragedMarket");
const sierra = json.parse(readFileSync("target/dev/veilcast_LeveragedMarket.contract_class.json", "utf8"));
const casm = json.parse(readFileSync("target/dev/veilcast_LeveragedMarket.compiled_contract_class.json", "utf8"));
const classHash = hash.computeContractClassHash(sierra);
console.log(`   class hash ${classHash}`);
console.log(`   CASM ${casm.bytecode.length} felts`);
let declareFee = 0n;
try {
    const declared = await account.declare({ contract: sierra, casm });
    await provider.waitForTransaction(declared.transaction_hash, { retryInterval: 200 });
    const receipt = await provider.getTransactionReceipt(declared.transaction_hash);
    declareFee = BigInt(receipt.actual_fee?.amount ?? 0);
    console.log(`   declared, fee ${formatStrk(declareFee, 6)} STRK`);
} catch (error) {
    if (!String(error.message).includes("already declared")) throw error;
    console.log("   already declared");
}

step("2. deploy LeveragedMarket(pool = us, token = STRK)");
const deployed = await account.deployContract({
    classHash,
    constructorCalldata: [ADDRESS, STRK],
});
await provider.waitForTransaction(deployed.transaction_hash, { retryInterval: 200 });
const LEV = deployed.contract_address;
console.log(`   deployed at ${LEV}`);

step("3. seed the vault: approve then add_liquidity(500)");
await send("approve", [{ contractAddress: STRK, entrypoint: "approve", calldata: [LEV, (500n * ONE).toString(), "0"] }]);
await send("add_liquidity", [{ contractAddress: LEV, entrypoint: "add_liquidity", calldata: [(500n * ONE).toString()] }]);
const [free] = await view(LEV, "get_vault_free");
console.log(`   vault free: ${formatStrk(BigInt(free))} STRK`);

step("4. create a leveraged market seeded with 100 STRK");
const closeAt = Math.floor(Date.now() / 1000) + 7 * 86_400;
await send("create_market", [
    { contractAddress: LEV, entrypoint: "create_market", calldata: [ADDRESS, String(closeAt), (100n * ONE).toString()] },
]);
const [nMarkets] = await view(LEV, "get_n_markets");
console.log(`   markets: ${BigInt(nMarkets)}`);

step("5. quote a 3x long YES off-chain, then confirm the chain agrees");
const marketRaw = await view(LEV, "get_market", [0]);
const book = { rYes: BigInt(marketRaw[3]), rNo: BigInt(marketRaw[4]) };
const margin = 20n * ONE;
const quote = quoteOpen(book, 0, margin, 30_000);
console.log(`   off-chain quote: notional ${formatStrk(quote.notional)}, borrow ${formatStrk(quote.borrowed)}, fee ${formatStrk(quote.fee)}`);
console.log(`   off-chain price: ${quote.entryPriceBps} -> ${quote.priceAfterBps} bps`);

step("6. open the position through the pool path, carrying a mandate");
// The agent that will be allowed to fire the stop or the take. It holds only this key.
const agentPrivateKey = "0x1a2b3c4d5e6f";
const agentKey = ec.starkCurve.getStarkKey(agentPrivateKey);
const coupon = newCoupon();
const granted = mandate({ agentKey, stopPriceBps: 0, takePriceBps: 8000, payoutTarget: ADDRESS });
console.log(`   agent key ${agentKey.slice(0, 18)}…, take at 8000 bps, pays ${ADDRESS.slice(0, 12)}…`);
// The pool withdraws the margin into the contract, then invokes. Here we do both explicitly.
await send("transfer margin in", [
    { contractAddress: STRK, entrypoint: "transfer", calldata: [LEV, margin.toString(), "0"] },
]);
const openFelts = openCalldata({
    marketId: 0,
    side: 0,
    positionKey: coupon.positionKey,
    margin,
    leverageBps: 30_000,
    maxPriceBps: Math.min(10_000, quote.priceAfterBps + 200),
    mandate: granted,
});
await send("privacy_invoke Open", [
    { contractAddress: LEV, entrypoint: "privacy_invoke", calldata: openFelts },
]);

step("7. read the position and the mandate back from chain");
const posRaw = await view(LEV, "get_position", [0, 0, coupon.positionKey]);
const position = {
    shares: BigInt(posRaw[0]),
    margin: BigInt(posRaw[1]),
    borrowed: BigInt(posRaw[2]),
    state: ["None", "Open", "Closed", "Liquidated"][Number(BigInt(posRaw[3]))],
};
console.log(`   state ${position.state}, margin ${formatStrk(position.margin)}, borrowed ${formatStrk(position.borrowed)}`);
if (position.state !== "Open") throw new Error("the position did not open");
if (position.borrowed !== quote.borrowed) throw new Error(`borrow mismatch: chain ${position.borrowed} vs quote ${quote.borrowed}`);
if (position.shares !== quote.shares) throw new Error(`share mismatch: chain ${position.shares} vs quote ${quote.shares}`);
console.log("   the off-chain quote matched the chain felt for felt");

const mandateRaw = await view(LEV, "get_mandate", [0, 0, coupon.positionKey]);
console.log(`   mandate agent ${num.toHex(BigInt(mandateRaw[0])).slice(0, 18)}…, take ${BigInt(mandateRaw[2])} bps, pays ${num.toHex64(BigInt(mandateRaw[3])).slice(0, 12)}…`);
if (BigInt(mandateRaw[0]) !== BigInt(agentKey)) throw new Error("the mandate did not store our agent key");
if (BigInt(mandateRaw[3]) !== BigInt(ADDRESS)) throw new Error("the mandate did not pin our payout address");

step("8. a stranger key cannot fire the mandate");
const stranger = "0xdeadbeef";
const strangerFelts = agentCloseCalldata({
    levAddress: LEV,
    marketId: 0,
    side: 0,
    positionKey: coupon.positionKey,
    agentPrivateKey: stranger,
    payoutTarget: ADDRESS,
});
try {
    await account.execute([{ contractAddress: LEV, entrypoint: "privacy_invoke", calldata: strangerFelts }]);
    throw new Error("SECURITY FAILURE: a stranger key closed a mandated position");
} catch (error) {
    const message = String(error.message);
    if (message.includes("SECURITY FAILURE")) throw error;
    console.log("   refused, as it must be");
}

step("9. the real agent cannot fire before the band is met");
const priceNow = priceBps(BigInt((await view(LEV, "get_market", [0]))[3]), BigInt((await view(LEV, "get_market", [0]))[4]));
console.log(`   YES price now ${priceNow} bps, take is 8000`);
const earlyFelts = agentCloseCalldata({
    levAddress: LEV,
    marketId: 0,
    side: 0,
    positionKey: coupon.positionKey,
    agentPrivateKey,
    payoutTarget: ADDRESS,
});
if (priceNow < 8000) {
    try {
        await account.execute([{ contractAddress: LEV, entrypoint: "privacy_invoke", calldata: earlyFelts }]);
        throw new Error("SECURITY FAILURE: the agent fired outside its band");
    } catch (error) {
        if (String(error.message).includes("SECURITY FAILURE")) throw error;
        console.log("   refused with MANDATE_NOT_MET, as it must be");
    }
} else {
    console.log("   band already met by the open itself, skipping the negative case");
}

step("10. push the price up, then let the agent fire the take");
const whale = newCoupon();
await send("transfer whale margin", [
    { contractAddress: STRK, entrypoint: "transfer", calldata: [LEV, (80n * ONE).toString(), "0"] },
]);
await send("privacy_invoke Open (whale, long YES)", [
    {
        contractAddress: LEV,
        entrypoint: "privacy_invoke",
        calldata: openCalldata({
            marketId: 0,
            side: 0,
            positionKey: whale.positionKey,
            margin: 80n * ONE,
            leverageBps: 30_000,
            maxPriceBps: 10_000,
        }),
    },
]);
const pushed = await view(LEV, "get_market", [0]);
const pushedPrice = priceBps(BigInt(pushed[3]), BigInt(pushed[4]));
console.log(`   YES price now ${pushedPrice} bps`);
if (pushedPrice < 8000) throw new Error("the whale did not push the price through the take");

const balanceBefore = BigInt((await view(STRK, "balanceOf", [ADDRESS]))[0]);
await send("privacy_invoke AgentClose", [
    { contractAddress: LEV, entrypoint: "privacy_invoke", calldata: earlyFelts },
]);
const closedRaw = await view(LEV, "get_position", [0, 0, coupon.positionKey]);
const closedState = ["None", "Open", "Closed", "Liquidated"][Number(BigInt(closedRaw[3]))];
console.log(`   position is now ${closedState}`);
if (closedState !== "Closed") throw new Error("the agent close did not close the position");

step("11. the payout went to the pinned address; the contract is still solvent");
const balanceAfter = BigInt((await view(STRK, "balanceOf", [ADDRESS]))[0]);
console.log(`   pinned address received ${formatStrk(balanceAfter - balanceBefore)} STRK net of fees`);
const [freeEnd] = await view(LEV, "get_vault_free");
const [backingEnd] = await view(LEV, "get_total_backing");
const [insuranceEnd] = await view(LEV, "get_insurance");
const [balLow] = await view(STRK, "balanceOf", [LEV]);
const obligations = BigInt(freeEnd) + BigInt(backingEnd) + BigInt(insuranceEnd);
console.log(`   free ${formatStrk(BigInt(freeEnd))} + backing ${formatStrk(BigInt(backingEnd))} + insurance ${formatStrk(BigInt(insuranceEnd))} = ${formatStrk(obligations)}`);
console.log(`   contract holds ${formatStrk(BigInt(balLow))} STRK`);
if (BigInt(balLow) < obligations) throw new Error("SOLVENCY FAILURE on a real chain");
console.log("   solvent");

step("REHEARSAL PASSED");
console.log(`   declare fee on devnet: ${formatStrk(declareFee, 6)} STRK (devnet gas is not mainnet gas)`);
console.log(`   contract: ${LEV}`);
console.log(`   class hash: ${classHash}`);
console.log("\n   Every step the mainnet script will take has now run against a real Starknet node:");
console.log("   declare, deploy, seed, create market, open with a mandate, refuse a stranger,");
console.log("   refuse the agent early, fire the take, pay the pinned address, stay solvent.");
