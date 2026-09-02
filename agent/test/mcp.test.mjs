/// The MCP surface, tested without a transport or a network.
///
/// Worth pinning tightly, because a browser host is the one caller that cannot be debugged by reading a
/// terminal: a malformed tool list or a stray byte on stdout shows up as "the integration does not work"
/// with nothing to look at. Every assertion here is about a shape a host depends on.

import { strict as assert } from "node:assert";
import test from "node:test";
import { PROTOCOL_VERSIONS, SERVER_INFO, handle, readResource, resourceList, toolList } from "../src/mcp.mjs";

const config = { network: "mainnet", pool: "0x1", token: "0x2", market: "0x3", leverage: "0x4", rpcUrl: "http://x" };

test("initialize answers with the version the host asked for when we speak it", async () => {
    // A host that pinned an older date is telling us what it can parse, so echoing the newest would
    // hand it a document it may not understand.
    for (const wanted of PROTOCOL_VERSIONS) {
        const response = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: wanted } }, { config });
        assert.equal(response.result.protocolVersion, wanted);
    }
});

test("initialize falls back to the newest version for an unknown one", async () => {
    const response = await handle(
        { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } },
        { config }
    );
    assert.equal(response.result.protocolVersion, PROTOCOL_VERSIONS[0]);
    assert.equal(response.result.serverInfo.name, SERVER_INFO.name);
});

test("initialize carries instructions that name the privacy rule", async () => {
    // The one claim a model must not get wrong when it describes this to a user.
    const response = await handle({ jsonrpc: "2.0", id: 1, method: "initialize" }, { config });
    assert.match(response.result.instructions, /identity privacy/);
    assert.match(response.result.instructions, /not amount privacy/);
});

test("a notification gets no response at all", async () => {
    // A host waiting for a reply to a notification hangs forever, so this is not cosmetic.
    assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }, { config }), null);
    assert.equal(await handle({ jsonrpc: "2.0", method: "tools/list" }, { config }), null);
});

test("every tool has a name a host can call and a schema it can fill", async () => {
    for (const tool of toolList()) {
        assert.match(tool.name, /^[a-z][a-z0-9_]*$/, `${tool.name} must be snake_case with no dashes`);
        assert.ok(tool.description.length > 20, `${tool.name} needs a real description`);
        assert.equal(tool.inputSchema.type, "object");
        for (const name of tool.inputSchema.required ?? []) {
            assert.ok(name in tool.inputSchema.properties, `${tool.name} requires ${name} but does not declare it`);
        }
    }
});

test("confirm is never required, because a dry run is the default", () => {
    // If a schema demanded confirm, a model would set it to satisfy the schema and spend money to do it.
    for (const tool of toolList()) {
        assert.ok(!(tool.inputSchema.required ?? []).includes("confirm"), `${tool.name} must not require confirm`);
    }
});

test("every tool that spends says so in its description", () => {
    const spenders = ["shield", "bet", "lev_open", "agent_close", "liquidate"];
    for (const tool of toolList()) {
        const shouldSpend = spenders.includes(tool.name);
        assert.equal(
            /SPENDS MONEY/.test(tool.description),
            shouldSpend,
            `${tool.name} description does not match whether it spends`
        );
    }
});

test("the verbs a browser host cannot use are absent, not broken", () => {
    // A menu with an item that cannot work is worse than a shorter menu.
    const names = toolList().map((tool) => tool.name);
    for (const withheld of ["init", "keeper", "watch", "lev_close"]) {
        assert.ok(!names.includes(withheld), `${withheld} must not be offered`);
    }
});

test("asking for a withheld tool explains why rather than just failing", async () => {
    const response = await handle(
        { jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "lev_close", arguments: {} } },
        { config }
    );
    assert.equal(response.error.code, -32602);
    assert.match(response.error.data.withheld, /coupon/);
    assert.ok(Array.isArray(response.error.data.available));
});

test("a tool that refuses is content with isError, not a protocol error", async () => {
    // The call itself succeeded. A model needs to read why the answer was no rather than see a transport
    // failure, which it would retry.
    const response = await handle(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "vault", arguments: {} } },
        { config, run: async () => ({ ok: false, command: "vault", code: 2, error: "REFUSED", message: "no" }) }
    );
    assert.equal(response.error, undefined);
    assert.equal(response.result.isError, true);
    assert.equal(JSON.parse(response.result.content[0].text).error, "REFUSED");
});

test("bigint amounts survive the wire as decimal strings", async () => {
    // Every amount in this system is a bigint. JSON.stringify throws on one rather than coercing it.
    const response = await handle(
        { jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "vault", arguments: {} } },
        { config, run: async () => ({ ok: true, command: "vault", data: { free: 10n ** 18n } }) }
    );
    assert.equal(JSON.parse(response.result.content[0].text).data.free, "1000000000000000000");
});

test("an unknown method is method-not-found rather than a crash", async () => {
    const response = await handle({ jsonrpc: "2.0", id: 5, method: "nope/nope" }, { config });
    assert.equal(response.error.code, -32601);
});

test("resources include the privacy document, which never claims amounts are private", () => {
    const uris = resourceList().map((entry) => entry.uri);
    assert.ok(uris.includes("veilcast://privacy"));
    const doc = readResource("veilcast://privacy").text;
    assert.match(doc, /identity privacy, not amount privacy/);
    // The exact overclaim this document exists to prevent.
    assert.ok(!/amounts are private/i.test(doc));
});

test("the capabilities resource is the same manifest the skill files carry", () => {
    const facts = JSON.parse(readResource("veilcast://capabilities", { config, agentPublicKey: "0xa9e" }).text);
    assert.equal(facts.schema, "veilcast-agent/capabilities@1");
    assert.equal(facts.agentPublicKey, "0xa9e");
    assert.ok(facts.commands.length >= 20);
    assert.ok(facts.trustBoundary.agentCannot.length >= 4, "the trust boundary must be in the resource a host reads");
});

test("an unknown resource throws rather than returning empty content", () => {
    assert.throws(() => readResource("veilcast://nope"), /No resource at/);
});
