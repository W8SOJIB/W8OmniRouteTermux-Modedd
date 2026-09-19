import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TEST_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omniroute-skills-injection-"));
process.env.DATA_DIR = TEST_DATA_DIR;

const coreDb = await import("../../src/lib/db/core.ts");
const { GLOBAL_SKILL_OWNER_ID, skillRegistry } = await import("../../src/lib/skills/registry.ts");
const { injectSkills, injectSkillTools, detectProvider, decodeSkillToolName } =
  await import("../../src/lib/skills/injection.ts");

// Since #9058, identifiers that violate the provider tool-name pattern
// (^[a-zA-Z0-9_-]+$ — every name@version here, because of "@" and ".") are
// encoded as omr_skill_<base64url(name@version)>, and bare property-map
// schemas are normalized to { type: "object", properties: {...} }.
function encodedName(identifier: string): string {
  return `omr_skill_${Buffer.from(identifier, "utf8").toString("base64url")}`;
}

function resetRegistryState() {
  skillRegistry["registeredSkills"].clear();
  skillRegistry["versionCache"].clear();
}

async function resetStorage() {
  resetRegistryState();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
}

async function registerSkills() {
  await skillRegistry.register({
    name: "search",
    version: "1.0.0",
    description: "search the web",
    schema: { input: { query: "string" }, output: { results: [] } },
    handler: "search-handler",
    enabled: true,
    apiKeyId: "key-a",
  });
  await skillRegistry.register({
    name: "disabled",
    version: "1.0.0",
    description: "should not be exposed",
    schema: { input: {}, output: {} },
    handler: "disabled-handler",
    enabled: false,
    apiKeyId: "key-a",
  });
}

test.beforeEach(async () => {
  await resetStorage();
});

test.after(() => {
  resetRegistryState();
  coreDb.resetDbInstance();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

test("injectSkills renders enabled tools in provider-specific shapes", async () => {
  await registerSkills();

  const openaiTools = injectSkills({
    provider: "openai",
    existingTools: [{ name: "existing-tool" }],
    apiKeyId: "key-a",
  });
  const claudeTools = injectSkills({ provider: "anthropic", apiKeyId: "key-a" });
  const geminiTools = injectSkills({ provider: "google", apiKeyId: "key-a" });
  const fallbackTools = injectSkills({ provider: "other", apiKeyId: "key-a" });

  assert.equal(openaiTools.length, 2);
  assert.deepEqual(openaiTools[0], {
    type: "function",
    function: {
      name: "omr_skill_c2VhcmNoQDEuMC4w", // encodedName("search@1.0.0")
      description: "search the web",
      parameters: { type: "object", properties: { query: "string" } },
    },
  });
  assert.equal(decodeSkillToolName("omr_skill_c2VhcmNoQDEuMC4w"), "search@1.0.0");
  assert.deepEqual(openaiTools[1], { name: "existing-tool" });
  assert.deepEqual(claudeTools, [
    {
      name: "omr_skill_c2VhcmNoQDEuMC4w",
      description: "search the web",
      input_schema: { type: "object", properties: { query: "string" } },
    },
  ]);
  assert.deepEqual(geminiTools, [
    {
      name: "omr_skill_c2VhcmNoQDEuMC4w",
      description: "search the web",
      parameters: { type: "object", properties: { query: "string" } },
    },
  ]);
  assert.deepEqual(fallbackTools, [openaiTools[0]]);
});

test("injectSkills includes global skills without leaking another API key's skills", async () => {
  await skillRegistry.register({
    name: "releaseNotes",
    version: "1.0.0",
    description: "draft release notes",
    schema: { input: {}, output: {} },
    handler: "release-notes-handler",
    enabled: true,
    apiKeyId: GLOBAL_SKILL_OWNER_ID,
  });
  await skillRegistry.register({
    name: "privateSkill",
    version: "1.0.0",
    description: "private skill",
    schema: { input: {}, output: {} },
    handler: "private-handler",
    enabled: true,
    apiKeyId: "key-b",
  });

  const tools = injectSkills({ provider: "openai", apiKeyId: "key-a" });

  assert.equal(tools.length, 1);
  assert.equal(
    decodeSkillToolName((tools[0] as { function: { name: string } }).function.name),
    "releaseNotes@1.0.0"
  );
});

test("injectSkillTools only injects into the last user message without tools", async () => {
  await registerSkills();

  const injected = injectSkillTools(
    [
      { role: "system", content: "be helpful" },
      { role: "user", content: "search docs" },
    ],
    "openai",
    "key-a"
  );

  assert.equal(injected.length, 2);
  assert.equal(injected[1].role, "user");
  assert.equal(Array.isArray(injected[1].tools), true);

  const unchangedWhenToolsExist = injectSkillTools(
    [{ role: "user", content: "already has tools", tools: [{ name: "existing" }] }],
    "openai",
    "key-a"
  );
  const unchangedAssistant = injectSkillTools(
    [{ role: "assistant", content: "no user tail" }],
    "openai",
    "key-a"
  );
  const unchangedWithoutSkills = injectSkillTools(
    [{ role: "user", content: "nothing to inject" }],
    "openai",
    "missing-key"
  );

  assert.deepEqual(unchangedWhenToolsExist, [
    { role: "user", content: "already has tools", tools: [{ name: "existing" }] },
  ]);
  assert.deepEqual(unchangedAssistant, [{ role: "assistant", content: "no user tail" }]);
  assert.deepEqual(unchangedWithoutSkills, [{ role: "user", content: "nothing to inject" }]);
});

test("detectProvider maps known model families and falls back to other", () => {
  assert.equal(detectProvider("gpt-4.1"), "openai");
  assert.equal(detectProvider("claude-sonnet-4"), "anthropic");
  assert.equal(detectProvider("gemini-2.5-pro"), "google");
  assert.equal(detectProvider("custom-router-model"), "other");
});

test("injectSkills auto mode matches message/context semantics and applies score threshold", async () => {
  await skillRegistry.register({
    name: "issueSearch",
    version: "1.0.0",
    description: "search github issues and pull requests",
    schema: { input: { query: "string" }, output: { results: [] } },
    handler: "search-handler",
    enabled: true,
    mode: "auto",
    tags: ["github", "issues", "search"],
    installCount: 42,
    apiKeyId: "key-auto",
  });

  await skillRegistry.register({
    name: "calendarPlanner",
    version: "1.0.0",
    description: "manage calendar scheduling",
    schema: { input: {}, output: {} },
    handler: "calendar-handler",
    enabled: true,
    mode: "auto",
    tags: ["calendar", "meeting"],
    installCount: 99,
    apiKeyId: "key-auto",
  });

  const tools = injectSkills({
    provider: "openai",
    apiKeyId: "key-auto",
    messages: [{ role: "user", content: "Please search github issues for flaky tests" }],
    existingTools: [],
  });

  assert.equal(Array.isArray(tools), true);
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0], {
    type: "function",
    function: {
      name: encodedName("issueSearch@1.0.0"),
      description: "search github issues and pull requests",
      parameters: { type: "object", properties: { query: "string" } },
    },
  });
});

test("injectSkills auto mode only scores name tokens with at least three characters", async () => {
  for (const name of ["aiSearch", "apiSearch"]) {
    await skillRegistry.register({
      name,
      version: "1.0.0",
      description: "find",
      schema: { input: {}, output: {} },
      handler: `${name}-handler`,
      enabled: true,
      mode: "auto",
      apiKeyId: "key-token-length",
    });
  }

  const tools = injectSkills({
    provider: "other",
    apiKeyId: "key-token-length",
    messages: [{ role: "user", content: "ai api find" }],
  });

  assert.deepEqual(
    tools.map((tool) =>
      decodeSkillToolName((tool as { function: { name: string } }).function.name)
    ),
    ["apiSearch@1.0.0"]
  );
});

test("injectSkills auto mode prefers provider-matching tagged skills", async () => {
  await skillRegistry.register({
    name: "openaiDocTool",
    version: "1.0.0",
    description: "openai docs lookup",
    schema: { input: {}, output: {} },
    handler: "openai-docs",
    enabled: true,
    mode: "auto",
    tags: ["openai", "docs", "lookup"],
    apiKeyId: "key-provider",
  });

  await skillRegistry.register({
    name: "claudeDocTool",
    version: "1.0.0",
    description: "anthropic docs lookup",
    schema: { input: {}, output: {} },
    handler: "claude-docs",
    enabled: true,
    mode: "auto",
    tags: ["anthropic", "docs", "lookup"],
    apiKeyId: "key-provider",
  });

  const tools = injectSkills({
    provider: "openai",
    apiKeyId: "key-provider",
    existingTools: [{ type: "function", function: { name: "docs_lookup" } }],
    messages: [{ role: "user", content: "lookup docs" }],
  });

  // Provider match is a ranking signal, not a hard exclusion rule.
  // Ensure openai-tagged skill is prioritized first.
  assert.equal(tools.length, 3);
  const injectedNames = tools
    .filter(
      (tool): tool is { function: { name: string } } =>
        !!tool && typeof tool === "object" && "function" in tool
    )
    .map((tool) => decodeSkillToolName(tool.function.name));
  assert.equal(injectedNames[0], "openaiDocTool@1.0.0");
  assert.equal(injectedNames.includes("claudeDocTool@1.0.0"), true);
});

test("injectSkills auto mode limits selected auto skills and keeps on-mode skills", async () => {
  await skillRegistry.register({
    name: "alwaysOnUtility",
    version: "1.0.0",
    description: "always available utility",
    schema: { input: {}, output: {} },
    handler: "always-on",
    enabled: true,
    mode: "on",
    apiKeyId: "key-limit",
  });

  for (let i = 0; i < 7; i++) {
    await skillRegistry.register({
      name: `searchSkill${i}`,
      version: "1.0.0",
      description: "search docs and files",
      schema: { input: {}, output: {} },
      handler: `search-${i}`,
      enabled: true,
      mode: "auto",
      tags: ["search", "docs"],
      installCount: i,
      apiKeyId: "key-limit",
    });
  }

  const tools = injectSkills({
    provider: "openai",
    apiKeyId: "key-limit",
    messages: [{ role: "user", content: "search docs and files quickly" }],
  });

  // 1 always-on + max 5 auto
  assert.equal(tools.length, 6);
  const names = tools.map((tool) =>
    decodeSkillToolName((tool as { function: { name: string } }).function.name)
  );
  assert.equal(names.includes("alwaysOnUtility@1.0.0"), true);
  assert.equal(names.filter((name) => name.startsWith("searchSkill")).length, 5);
});
