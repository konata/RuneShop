import { expect, test } from "bun:test";
import { normalize } from "../src/codex";

test("preserves native Codex responses requests", () => {
  const body = JSON.stringify({
    model: "gpt-5.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
    max_output_tokens: 100000,
    safety_identifier: "user",
    reasoning: { effort: "high", summary: "auto" }
  });

  expect(normalize(body, new Headers({ "x-codex-window-id": "window" }))).toEqual({
    body,
    stream: true,
    model: "gpt-5.5",
    native: true,
    changes: []
  });
});

test("normalizes generic Responses clients for Codex upstream", () => {
  const { body, stream, changes, native } = normalize(JSON.stringify({
    model: "gpt-5.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    max_output_tokens: 100000,
    safety_identifier: "user",
    stream_options: { include_obfuscation: false },
    reasoning: { effort: "high", summary: "auto" },
    include: ["reasoning.encrypted_content"]
  }));

  expect(stream).toBe(true);
  expect(native).toBe(false);
  expect(changes).toContain("set:store");
  expect(changes).toContain("set:parallel_tool_calls");
  expect(changes).toContain("drop:max_output_tokens");
  expect(changes).toContain("drop:safety_identifier");
  expect(changes).toContain("drop:stream_options");
  expect(changes).toContain("drop:reasoning.summary");
  expect(JSON.parse(body)).toEqual({
    model: "gpt-5.5",
    input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
    reasoning: { effort: "high" },
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true
  });
});

test("drops unknown generic fields instead of chasing upstream errors", () => {
  const { body, changes } = normalize(JSON.stringify({
    model: "gpt-5.5",
    input: "hi",
    stream: true,
    future_client_field: true
  }));

  expect(changes).toContain("rewrite:input");
  expect(changes).toContain("drop:future_client_field");
  expect(changes).toContain("set:store");
  expect(changes).toContain("set:include");
  expect(changes).toContain("set:parallel_tool_calls");
  expect(JSON.parse(body)).toEqual({
    model: "gpt-5.5",
    input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
    stream: true,
    store: false,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true
  });
});

test("preserves tool use payloads while applying generic compatibility", () => {
  const { body } = normalize(JSON.stringify({
    model: "gpt-5.5",
    input: [
      { role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call_output", call_id: "call_1", output: "file.txt" }
    ],
    tools: [
      {
        type: "function",
        name: "list",
        description: "List files",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    stream: true,
    max_output_tokens: 100000,
    reasoning: { effort: "high", summary: "auto" }
  }));

  expect(JSON.parse(body)).toEqual({
    model: "gpt-5.5",
    input: [
      { role: "user", content: [{ type: "input_text", text: "list files" }] },
      { type: "function_call_output", call_id: "call_1", output: "file.txt" }
    ],
    tools: [
      {
        type: "function",
        name: "list",
        description: "List files",
        parameters: { type: "object", properties: {}, additionalProperties: false }
      }
    ],
    tool_choice: "auto",
    parallel_tool_calls: true,
    include: ["reasoning.encrypted_content"],
    stream: true,
    store: false,
    reasoning: { effort: "high" }
  });
});

test("rewrites Codex-compatible roles, tools, and service tier", () => {
  const { body, changes } = normalize(JSON.stringify({
    model: "gpt-5.5",
    input: [{ type: "message", role: "system", content: [{ type: "input_text", text: "rules" }] }],
    tools: [{ type: "web_search_preview", name: "search" }],
    tool_choice: { type: "web_search_preview_2025_03_11" },
    service_tier: "default",
    store: true,
    include: ["other"],
    parallel_tool_calls: false
  }));

  expect(changes).toContain("rewrite:input.role");
  expect(changes).toContain("rewrite:tools.0.type");
  expect(changes).toContain("rewrite:tool_choice.type");
  expect(changes).toContain("drop:service_tier");
  expect(changes).toContain("rewrite:store");
  expect(changes).toContain("rewrite:include");
  expect(changes).toContain("rewrite:parallel_tool_calls");
  expect(JSON.parse(body)).toEqual({
    model: "gpt-5.5",
    input: [{ type: "message", role: "developer", content: [{ type: "input_text", text: "rules" }] }],
    tools: [{ type: "web_search", name: "search" }],
    tool_choice: { type: "web_search" },
    store: false,
    include: ["reasoning.encrypted_content"],
    parallel_tool_calls: true
  });
});
