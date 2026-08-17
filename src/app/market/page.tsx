import { Suspense } from "react";
import styles from "../uni.module.css";
import { Aurora, SiteFooter, SiteNav } from "../components/Chrome";
import MarketDetail from "../components/client/market/MarketDetail";

export const metadata = {
    title: "A market on Veilcast",
    description: "Public odds, anonymous bettors. One market on Veilcast, read straight off Starknet.",
};

/// A market's own page, so a market can be linked to. The id arrives as a query parameter rather
/// than a path segment, because the app is a static export and a path per market would mean
/// prerendering every market that will ever exist.
export default function Page() {
    return (
        <div className={styles.page}>
            <Aurora />
            <SiteNav />
            <main className={styles.detailMain}>
                <Suspense fallback={<div className={styles.panelWide} />}>
                    <MarketDetail />
                </Suspense>
            </main>
            <SiteFooter />
        </div>
    );
}
