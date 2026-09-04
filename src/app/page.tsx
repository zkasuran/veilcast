import Home from "./components/client/Home";

/// The home page is now a thin shell over a client dashboard: the live board, the analytics radar,
/// the shortlist and the trading surface all sit behind one polling board so every tab agrees about
/// what the chain said.
export default function Page() {
    return <Home />;
}
