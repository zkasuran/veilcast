/// A read-only tour of a Veilcast deployment: print the board, then one market's odds history.
///
/// Run with a market address and a provider URL, no wallet and no key:
///
///   npx tsx examples/read-board.ts \
///     --market 0x... \
///     --rpc https://api.cartridge.gg/x/starknet/sepolia
///
/// Everything it prints is public on-chain data. None of it identifies a bettor, because the market
/// is never told one.

import { RpcProvider } from "starknet";
import { formatStrk, impliedProbability, loadBoard, loadMarketEvents, oddsSeries } from "veilcast-sdk";

function arg(name: string, fallback: string): string {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

async function main() {
    const market = arg("market", "");
    const rpc = arg("rpc", "https://api.cartridge.gg/x/starknet/sepolia");
    if (!market) throw new Error("pass --market <address>");

    const provider = new RpcProvider({ nodeUrl: rpc });
    const board = await loadBoard(provider, market);
    console.log(`${board.length} markets\n`);

    for (const view of board) {
        const odds = view.labels
            .map((label, i) => `${label} ${Math.round(impliedProbability(view.volumes[i], view.pot, view.labels.length) * 100)}%`)
            .join("  ");
        console.log(`#${view.id}  ${view.question}`);
        console.log(`   ${odds}   pot ${formatStrk(view.pot)} STRK   [${view.state}]\n`);
    }

    if (board.length > 0) {
        const first = board[board.length - 1];
        const events = await loadMarketEvents(provider, market, first.id);
        const points = oddsSeries(events, first.labels.length);
        console.log(`market #${first.id} moved over ${points.length} bets`);
        for (const point of points) {
            const line = point.probabilities.map((p) => `${Math.round(p * 100)}%`).join(" / ");
            console.log(`   bet ${point.index}: ${line}`);
        }
    }
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
