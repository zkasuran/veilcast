#!/usr/bin/env node
/// The MCP transport: newline-delimited JSON-RPC over stdio.
///
/// stdio is what every MCP host can launch, needing no port, no TLS and no auth story. A remote
/// host that wants HTTP puts a proxy in front of this rather than making the runtime own a server.
///
/// Reads are framed by newline. A JSON document can contain newlines inside strings, but a request per
/// line is what the reference implementations emit and accept.

import { createInterface } from "node:readline";
import { configFrom } from "./config.mjs";
import { readAgentKey } from "./keys.mjs";
import { handle } from "./mcp.mjs";

export async function serve({ input = process.stdin, output = process.stdout, argv = [] } = {}) {
    const args = {};
    for (let index = 0; index < argv.length; index += 1) {
        const flag = argv[index];
        if (!flag.startsWith("--")) continue;
        const next = argv[index + 1];
        args[flag.slice(2)] = next && !next.startsWith("--") ? next : true;
    }
    const config = configFrom(args);
    // An absent key is normal: a host may only ever read. readAgentKey throws rather than returning
    // null, because for every other caller a missing key is a setup error worth naming.
    let publicKey = null;
    try {
        publicKey = readAgentKey(config).publicKey;
    } catch {
        publicKey = null;
    }

    // Nothing but JSON-RPC may ever reach stdout: a stray log line desynchronises the host's parser and
    // the session dies with no useful error. Progress goes to stderr.
    process.stderr.write(
        `veilcast MCP server on stdio. network ${config.network}, agent key ${publicKey ? "present" : "absent"}.\n`
    );

    const lines = createInterface({ input, crlfDelay: Infinity });
    for await (const line of lines) {
        const text = line.trim();
        if (!text) continue;
        let request;
        try {
            request = JSON.parse(text);
        } catch {
            output.write(
                `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } })}\n`
            );
            continue;
        }
        // A batch is an array. Notifications inside it produce nothing, so an all-notification batch
        // correctly writes no response at all.
        if (Array.isArray(request)) {
            const responses = [];
            for (const one of request) {
                const response = await handle(one, { config, agentPublicKey: publicKey });
                if (response) responses.push(response);
            }
            if (responses.length > 0) output.write(`${JSON.stringify(responses)}\n`);
            continue;
        }
        const response = await handle(request, { config, agentPublicKey: publicKey });
        if (response) output.write(`${JSON.stringify(response)}\n`);
    }
}

// Run when invoked directly, stay importable for tests.
if (import.meta.url === `file://${process.argv[1]}`) {
    await serve({ argv: process.argv.slice(2) });
}
