import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// The app resolves "@/..." through tsconfig paths, which vitest does not read, so the one alias the
// tests need is mirrored here.
export default defineConfig({
    resolve: { alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) } },
    test: { environment: "node", include: ["src/**/*.test.ts", "sdk/src/**/*.test.ts"] },
});
