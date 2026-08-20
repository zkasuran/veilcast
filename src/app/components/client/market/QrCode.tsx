"use client";

import qrcode from "qrcode-generator";
import { useMemo } from "react";

/// A QR code as inline SVG, so moving a coupon to a phone needs no camera-side app beyond a scanner
/// and no image host. Error-correction level M survives a bit of screen glare; the caller keeps the
/// payload small (a single bearer ticket, never a whole vault) so the code stays scannable.
export default function QrCode({ text, size = 176 }: { text: string; size?: number }) {
    const path = useMemo(() => {
        // Type 0 lets the library pick the smallest version that fits the data.
        const qr = qrcode(0, "M");
        qr.addData(text);
        qr.make();
        const count = qr.getModuleCount();
        const cells: string[] = [];
        for (let row = 0; row < count; row += 1) {
            for (let col = 0; col < count; col += 1) {
                if (qr.isDark(row, col)) cells.push(`M${col},${row}h1v1h-1z`);
            }
        }
        return { d: cells.join(""), count };
    }, [text]);

    // One SVG unit per module, scaled by viewBox, with a one-module quiet border around it.
    const box = path.count + 2;
    return (
        <svg
            width={size}
            height={size}
            viewBox={`-1 -1 ${box} ${box}`}
            role="img"
            aria-label="QR code of a Veilcast coupon ticket"
            shapeRendering="crispEdges"
            style={{ background: "#fff", borderRadius: 10, padding: 6, display: "block" }}
        >
            <path d={path.d} fill="#0d0e0e" />
        </svg>
    );
}
