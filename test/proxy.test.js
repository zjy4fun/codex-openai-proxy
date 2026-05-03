const assert = require("node:assert/strict");
const test = require("node:test");

const { buildResponsesPayload } = require("../src/proxy");

test("does not forward unsupported token limit parameters to Codex backend", () => {
  const payload = buildResponsesPayload(
    {
      model: "gpt-5.4-mini",
      max_tokens: 128,
      max_completion_tokens: 256,
      messages: [{ role: "user", content: "hello" }],
    },
    "gpt-5.4-mini",
  );

  assert.equal(Object.hasOwn(payload, "max_output_tokens"), false);
  assert.equal(Object.hasOwn(payload, "maxoutputtokens"), false);
});
