// Checks that the Scriptable exporter's YAML output matches what the macOS
// Python exporter (PyYAML safe_dump) would produce, so the two can update the
// same file without spurious commits.
//
//   node reminders/yaml_compat_test.js

const assert = require("assert");
const { execFileSync } = require("child_process");
const { toYaml, comparable, selectReminders } = require("./export_reminders_to_github.js");

const TITLES = [
  "Buy chainsaw bar oil",
  "",
  "no",
  "yes",
  "y",
  "N",
  "null",
  "~",
  "true",
  "False",
  "on",
  "off",
  "12345",
  "1.5",
  "1e5",
  "1e+5",
  "0x1f",
  "0b101",
  "0o17",
  "017",
  "09",
  "12_000",
  "0",
  "<<",
  "=",
  "1:30",
  "-5",
  "+3",
  ".inf",
  ".NaN",
  "2026-08-26",
  "2026-08-26 17:00",
  "-foo",
  "- foo",
  "?maybe",
  "? maybe",
  ":run",
  ": run",
  "#tag",
  "a #tag",
  "a#tag",
  "key: value",
  "key:value",
  "ends with colon:",
  "*star",
  "&anchor",
  "!bang",
  "|pipe",
  ">gt",
  "%percent",
  "@at",
  "`tick",
  "'single'",
  '"double"',
  "{brace}",
  "[bracket]",
  "comma,separated",
  " leading space",
  "trailing space ",
  "tab\there",
  "line one\nline two",
  "line one\n\nline three",
  "trailing break\n",
  "\nleading break",
  "space before\n break",
  "space after \nbreak",
  "non\u00a0breaking\u00a0spaces",
  "tab\tand emoji \ud83e\udea3",
  "emoji 🪓 and ünïcode",
  "it's got an apostrophe",
  "Split the woodpile — dash",
];

const payload = {
  version: 2,
  source: "eventkit",
  generated_at: "2026-09-08T03:00:00Z",
  reminders: TITLES.map((title, index) => ({
    title,
    list: index % 2 ? "Home" : "Errands",
    notes: index % 3 ? "" : title,
    created: "2026-08-20T14:12:00Z",
    due: "2026-08-26T17:00:00Z",
    completed_at: index % 4 ? "" : "2026-08-27T09:00:00Z",
    priority: index % 10,
    flagged: false,
    completed: index % 4 === 0,
  })),
};

const expected = execFileSync(
  "python3",
  [
    "-c",
    [
      "import json, sys, yaml",
      "payload = json.load(sys.stdin)",
      "sys.stdout.write(yaml.safe_dump(payload, default_flow_style=False, sort_keys=False, allow_unicode=True, width=4096))",
    ].join("\n"),
  ],
  { input: JSON.stringify(payload), encoding: "utf-8" }
);

function assertSameYaml(actual, expectedText, label) {
  if (actual === expectedText) return;
  const actualLines = actual.split("\n");
  const expectedLines = expectedText.split("\n");
  const mismatches = [];
  for (let i = 0; i < Math.max(actualLines.length, expectedLines.length); i += 1) {
    if (actualLines[i] !== expectedLines[i]) {
      mismatches.push(`line ${i + 1}:\n  scriptable: ${JSON.stringify(actualLines[i])}\n  pyyaml:     ${JSON.stringify(expectedLines[i])}`);
    }
  }
  assert.fail(`${label}\n${mismatches.slice(0, 20).join("\n")}\n(${mismatches.length} mismatching lines)`);
}

assertSameYaml(toYaml(payload), expected, "Scriptable YAML differs from PyYAML output");

// Empty payloads.
const emptyPayload = { ...payload, reminders: [] };
const emptyExpected = execFileSync(
  "python3",
  [
    "-c",
    [
      "import json, sys, yaml",
      "payload = json.load(sys.stdin)",
      "sys.stdout.write(yaml.safe_dump(payload, default_flow_style=False, sort_keys=False, allow_unicode=True, width=4096))",
    ].join("\n"),
  ],
  { input: JSON.stringify(emptyPayload), encoding: "utf-8" }
);
assertSameYaml(toYaml(emptyPayload), emptyExpected, "empty reminder list differs from PyYAML output");

// The emitted YAML must load back to the exact payload.
const roundTripped = JSON.parse(
  execFileSync(
    "python3",
    ["-c", "import json, sys, yaml\nsys.stdout.write(json.dumps(yaml.safe_load(sys.stdin.read())))"],
    { input: toYaml(payload), encoding: "utf-8" }
  )
);
assert.deepStrictEqual(roundTripped, payload, "emitted YAML does not load back to the payload");

// A different generated_at must not count as a change.
assert.strictEqual(
  comparable(toYaml(payload)),
  comparable(toYaml({ ...payload, generated_at: "2026-09-09T04:00:00Z" })),
  "generated_at should be ignored when comparing"
);

// Selection rules: open reminders need a due date, completed ones need a due
// date and a completion inside the 90-day window.
const now = new Date("2026-09-08T00:00:00Z");
const calendar = { title: "Home" };
const selected = selectReminders(
  [
    { title: "open with due", calendar, dueDate: new Date("2026-09-01T00:00:00Z"), isCompleted: false, priority: 1 },
    { title: "open no due", calendar, dueDate: null, isCompleted: false, priority: 0 },
    {
      title: "completed recently",
      calendar,
      dueDate: new Date("2026-08-01T00:00:00Z"),
      isCompleted: true,
      completionDate: new Date("2026-08-02T00:00:00Z"),
      priority: 0,
    },
    {
      title: "completed long ago",
      calendar,
      dueDate: new Date("2025-01-01T00:00:00Z"),
      isCompleted: true,
      completionDate: new Date("2025-01-02T00:00:00Z"),
      priority: 0,
    },
    { title: "completed no due", calendar, dueDate: null, isCompleted: true, completionDate: now, priority: 0 },
  ],
  now,
  true
);
assert.deepStrictEqual(
  selected.map((reminder) => reminder.title),
  ["completed recently", "open with due"]
);
assert.deepStrictEqual(
  selectReminders(
    [
      {
        title: "completed recently",
        calendar,
        dueDate: new Date("2026-08-01T00:00:00Z"),
        isCompleted: true,
        completionDate: new Date("2026-08-02T00:00:00Z"),
        priority: 0,
      },
    ],
    now,
    false
  ),
  []
);

console.log("yaml_compat_test: all checks passed");
