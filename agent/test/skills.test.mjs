/// Tests for the skill packs and the install path.
///
/// The point of these is that a host reads a file we generated and it is valid for THAT host, not
/// merely valid Markdown. A Claude Code skill with malformed frontmatter is silently ignored; an
/// openclaw tool manifest with a missing field is a tool that never gets called. So the shapes are
/// asserted, not eyeballed.

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    capabilities,
    detectHost,
    renderAgentsMd,
    renderClaudeSkill,
    renderHermesManifest,
    renderOpenclawTool,
    writeSkills,
} from "../src/install.mjs";
import { resolveConfig } from "../src/config.mjs";

const config = resolveConfig({}, {});
const facts = capabilities({ agentPublicKey: "0xa9e", config });

function scratch() {
    return mkdtempSync(join(tmpdir(), "veilcast-skills-"));
}

test("host detection prefers an explicit environment signal", () => {
    assert.equal(detectHost("/nowhere", { CLAUDE_CODE: "1" }), "claude");
    assert.equal(detectHost("/nowhere", { CLAUDECODE: "1" }), "claude");
    assert.equal(detectHost("/nowhere", { OPENCLAW_HOME: "/x" }), "openclaw");
    assert.equal(detectHost("/nowhere", { HERMES_HOME: "/x" }), "hermes");
    assert.equal(detectHost("/nowhere", {}), "generic");
});

test("the capability manifest describes commands, safety and the trust boundary", () => {
    assert.equal(facts.schema, "veilcast-agent/capabilities@1");
    assert.ok(facts.commands.length >= 15, "every verb must be described");
    assert.ok(facts.commands.every((command) => command.name && command.summary));
    // Every spending verb must be marked or a host could call it without asking.
    const spending = facts.commands.filter((command) => command.spends);
    assert.ok(spending.length >= 6);
    assert.ok(spending.every((command) => command.dryRunDefault === true));
    assert.ok(spending.every((command) => command.args.some((arg) => arg.includes("--confirm"))));
    // The trust boundary has to state both halves, because the negative is the security claim.
    assert.ok(facts.trustBoundary.agentCan.length >= 3);
    assert.ok(facts.trustBoundary.agentCannot.length >= 5);
    assert.match(facts.trustBoundary.consequence, /stolen agent key/i);
});

test("the manifest never claims amount privacy, which STRK20 does not provide", () => {
    const serialized = JSON.stringify(facts);
    assert.ok(facts.privacy.public.some((line) => line.includes("amount")), "amounts must be listed as public");
    assert.match(facts.privacy.doNotClaim, /not amount privacy/);
    // A blanket "fully private" claim anywhere would be an overclaim.
    assert.ok(!/fully private|completely private|amounts are private/i.test(serialized));
});

test("the Claude skill has exactly the frontmatter the host expects", () => {
    const skill = renderClaudeSkill(facts);
    const match = /^---\n([\s\S]*?)\n---\n/.exec(skill);
    assert.ok(match, "a Claude skill needs YAML frontmatter as the very first thing in the file");
    const keys = match[1]
        .split("\n")
        .filter((line) => line && !line.startsWith(" "))
        .map((line) => line.split(":")[0]);
    // Only name and description: extra keys are not part of the contract.
    assert.deepEqual(new Set(keys), new Set(["name", "description"]));
    assert.match(match[1], /^name: veilcast$/m);
    // The description is what the host matches on, so it has to carry trigger phrases.
    const description = /description: (.*)/.exec(match[1])[1];
    assert.ok(description.length > 200, "the description should be rich enough to match on");
    assert.ok(description.length < 1024, "and short enough for the host to accept");
    for (const trigger of ["veilcast", "prediction market", "STRK20", "keeper", "mandate"]) {
        assert.ok(description.toLowerCase().includes(trigger.toLowerCase()), `should trigger on ${trigger}`);
    }
    // Frontmatter must be a single block: a stray delimiter would truncate the body.
    assert.equal(skill.split("\n---\n").length, 2);
});

test("the Claude skill teaches the safety protocol and the refusal semantics", () => {
    const skill = renderClaudeSkill(facts);
    assert.match(skill, /dry run unless you pass `--confirm`/);
    assert.match(skill, /exits \*\*2\*\*/);
    assert.match(skill, /the answer was no, not maybe/);
    // It must tell the agent to refuse an owner key rather than accept it helpfully.
    assert.match(skill, /refuse and explain why/);
    // And name where the boundary is actually enforced, so the agent does not think it is honour code.
    assert.match(skill, /cairo\/src\/leveraged_market\.cairo/);
});

test("the openclaw tool manifest marks every mutating verb as needing confirmation", () => {
    const tool = renderOpenclawTool(facts);
    assert.equal(tool.schema, "openclaw/tool@1");
    assert.equal(tool.binary, "veilcast-agent");
    assert.equal(tool.output, "json");
    assert.ok(tool.verbs.length >= 15);
    for (const verb of tool.verbs) {
        assert.ok(verb.verb && verb.summary && verb.invoke);
        assert.equal(typeof verb.spends, "boolean");
        // The invariant that matters: spending implies requiring confirmation.
        assert.equal(verb.requiresConfirm, verb.spends);
    }
    assert.equal(tool.safety.dryRunByDefault, true);
    assert.equal(tool.safety.confirmFlag, "--confirm");
    assert.ok(tool.safety.prohibited.length >= 3);
    assert.ok(tool.exitCodes[2].includes("Retry later"));
});

test("the Hermes manifest lists mutating capabilities as policy, not advice", () => {
    const manifest = renderHermesManifest(facts);
    assert.equal(manifest.schema, "hermes/skill@1");
    assert.equal(manifest.entrypoint.command, "veilcast-agent");
    assert.equal(manifest.entrypoint.output, "json");
    const mutating = manifest.capabilities.filter((capability) => capability.mutating).map((c) => c.id);
    // Every mutating capability has to appear in the confirmation policy, with none missed.
    assert.deepEqual(new Set(mutating), new Set(manifest.policy.requireExplicitConfirmation));
    assert.equal(manifest.policy.dryRunFirst, true);
    assert.ok(manifest.onboarding.includes("veilcast-agent status"));
    assert.ok(manifest.trustModel.agentCannot.length >= 5);
});

test("AGENTS.md carries the protocol, both halves of the boundary and a worked example", () => {
    const brief = renderAgentsMd(facts);
    assert.match(brief, /# Veilcast for agents/);
    assert.match(brief, /## The money-safety protocol, every time/);
    assert.match(brief, /You cannot do the following\. The contract enforces it/);
    assert.match(brief, /veilcast-agent keeper-scan/);
    assert.match(brief, /veilcast-agent agent-close/);
    // Every exit code an agent can hit must be documented or it cannot branch reliably.
    for (const code of Object.keys(facts.exitCodes)) {
        assert.ok(brief.includes(`\`${code}\``), `exit code ${code} must be documented`);
    }
});

test("every generated document is free of house-style violations", () => {
    // No em dashes and no comma before and or or. The generated files are outward-facing prose, so
    // they are held to the same bar as anything else we publish.
    for (const [name, text] of [
        ["AGENTS.md", renderAgentsMd(facts)],
        ["SKILL.md", renderClaudeSkill(facts)],
        ["capabilities", JSON.stringify(facts, null, 2)],
        ["openclaw", JSON.stringify(renderOpenclawTool(facts), null, 2)],
        ["hermes", JSON.stringify(renderHermesManifest(facts), null, 2)],
    ]) {
        assert.ok(!text.includes("—"), `${name} contains an em dash`);
        assert.ok(!/, (and|or) /.test(text), `${name} contains a comma before and or or`);
    }
});

test("writeSkills writes the right files for each host and never clobbers by default", () => {
    for (const [host, expected] of [
        ["generic", [".veilcast/capabilities.json", "AGENTS.md"]],
        ["claude", [".veilcast/capabilities.json", "AGENTS.md", ".claude/skills/veilcast/SKILL.md"]],
        ["openclaw", [".openclaw/tools/veilcast.json", ".openclaw/skills/veilcast.md"]],
        ["hermes", [".hermes/skills/veilcast/manifest.json", ".hermes/skills/veilcast/README.md"]],
    ]) {
        const cwd = scratch();
        const result = writeSkills({ host, config, agentPublicKey: "0xa9e", cwd });
        assert.equal(result.host, host);
        for (const path of expected) {
            assert.ok(existsSync(join(cwd, path)), `${host} should write ${path}`);
            assert.ok(
                result.files.some((file) => file.path === path && file.written),
                `${host} should report writing ${path}`
            );
        }
        // Re-running must leave an edited file alone rather than overwriting a user's work.
        const again = writeSkills({ host, config, agentPublicKey: "0xa9e", cwd });
        assert.ok(again.files.every((file) => !file.written), "a second run should write nothing");
        assert.ok(again.files.every((file) => file.reason?.includes("already exists")));
        // Unless forced.
        const forced = writeSkills({ host, config, agentPublicKey: "0xa9e", cwd, force: true });
        assert.ok(forced.files.every((file) => file.written), "--force should overwrite");
    }
});

test("the written JSON files parse, so a host can actually load them", () => {
    const cwd = scratch();
    writeSkills({ host: "openclaw", config, agentPublicKey: "0xa9e", cwd });
    writeSkills({ host: "hermes", config, agentPublicKey: "0xa9e", cwd });
    const tool = JSON.parse(readFileSync(join(cwd, ".openclaw/tools/veilcast.json"), "utf8"));
    const manifest = JSON.parse(readFileSync(join(cwd, ".hermes/skills/veilcast/manifest.json"), "utf8"));
    const caps = JSON.parse(readFileSync(join(cwd, ".veilcast/capabilities.json"), "utf8"));
    assert.equal(tool.name, "veilcast");
    assert.equal(manifest.id, "veilcast");
    assert.equal(caps.schema, "veilcast-agent/capabilities@1");
});
