// Scriptable (iOS) port of reminders/export_reminders_to_github.py.
//
// Exports iOS Reminders and writes the same YAML payload to GitHub:
//   ideal-knee/reminder-data, branch main, file reminders.yaml
//
// Selection (identical to the macOS script):
//   - Every uncompleted reminder that has a due date (no cutoff).
//   - Every completed reminder that BOTH has a due date AND was completed in
//     the last 90 days.
//
// Setup:
//   1. Install Scriptable from the App Store and add this file as a script
//      (Files app -> Scriptable folder, or paste it into a new script).
//   2. Run it once from the Scriptable app. It asks for Reminders access and
//      for a GitHub token, which it stores in the iOS keychain under
//      "reminders-export".
//   3. Optional: Shortcuts -> Automation -> Time of Day -> Run Script
//      ("Run Immediately") to export on a schedule.
//
// Token permissions: Contents = Read and write on the target repository
// (fine-grained), or the repo / public_repo scope for a classic token.

const REPO = "ideal-knee/reminder-data";
const FILE_PATH = "reminders.yaml";
const BRANCH = "main";
const COMPLETED_CUTOFF_DAYS = 90;
const KEYCHAIN_KEY = "reminders-export";
const GITHUB_API = "https://api.github.com";

function log(message) {
  console.log(`[reminders-export] ${message}`);
}

function iso8601(date) {
  if (!date) return "";
  return `${date.toISOString().slice(0, 19)}Z`;
}

// --- YAML emitting -------------------------------------------------------
// Mirrors PyYAML's safe_dump(default_flow_style=False, sort_keys=False,
// allow_unicode=True, width=4096) closely enough that a payload written by
// the macOS script and one written here compare equal.

// A plain scalar may not start with an indicator (except '-', '?' and ':'
// when not followed by whitespace), may not contain ": " or " #", and may not
// have leading or trailing whitespace.
const PLAIN_UNSAFE = /^[,[\]{}#&*!|>'"%@`]|^[-?:](?:$|[ \t])|:(?:$|[ \t])|[ \t]#|^[ \t]|[ \t]$/;
// Strings that YAML 1.1 would resolve to a non-string type must be quoted.
const NON_STRING_LOOKALIKE =
  new RegExp(
    "^(?:" +
      // int
      "[-+]?0b[01_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][\\d_]*)|[-+]?0x[0-9a-fA-F_]+|[-+]?[1-9][\\d_]*(?::[0-5]?\\d)+" +
      // float
      "|[-+]?\\d[\\d_]*\\.[\\d_]*(?:[eE][-+]\\d+)?|\\.[\\d_]+(?:[eE][-+]\\d+)?|[-+]?\\d[\\d_]*(?::[0-5]?\\d)+\\.[\\d_]*|[-+]?\\.(?:inf|Inf|INF)|\\.(?:nan|NaN|NAN)" +
      // bool, null, value, merge
      "|yes|Yes|YES|no|No|NO|true|True|TRUE|false|False|FALSE|on|On|ON|off|Off|OFF|~|null|Null|NULL|=|<<" +
      // timestamp
      "|\\d{4}-\\d{2}-\\d{2}|\\d{4}-\\d{1,2}-\\d{1,2}(?:[Tt]|[ \\t]+)\\d{1,2}:\\d{2}:\\d{2}(?:\\.\\d*)?(?:[ \\t]*(?:Z|[-+]\\d{1,2}(?::\\d{2})?))?" +
      ")$"
  );
// A space next to a newline cannot survive single-quoted folding, so those
// strings are double quoted instead.
const UNFOLDABLE_BREAK = /[ \t]\n|\n[ \t]/;
// Characters that force double quoting: control characters and the ones YAML
// treats as line or byte-order marks. PyYAML instead folds NEL, LS and PS
// like ordinary line breaks; text containing them is still valid YAML here,
// just not byte-identical to the Python exporter's output.
const SPECIAL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufeff\u2028\u2029]/;
const DOUBLE_QUOTE_ESCAPES = {
  "\u0000": "\\0",
  "\u0007": "\\a",
  "\b": "\\b",
  "\t": "\\t",
  "\n": "\\n",
  "\v": "\\v",
  "\f": "\\f",
  "\r": "\\r",
  "\u001b": "\\e",
  '"': '\\"',
  "\\": "\\\\",
  "\u0085": "\\N",
  "\u2028": "\\L",
  "\u2029": "\\P",
};

// PyYAML's double-quoted style: printable ASCII and most of the BMP stay
// literal (allow_unicode), everything else is escaped.
function doubleQuoted(text) {
  let out = '"';
  for (const ch of text) {
    const escape = DOUBLE_QUOTE_ESCAPES[ch];
    if (escape !== undefined) {
      out += escape;
      continue;
    }
    const code = ch.codePointAt(0);
    const printable =
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0xa0 && code <= 0xd7ff) ||
      (code >= 0xe000 && code <= 0xfffd);
    if (printable) {
      out += ch;
    } else if (code <= 0xff) {
      out += `\\x${code.toString(16).toUpperCase().padStart(2, "0")}`;
    } else if (code <= 0xffff) {
      out += `\\u${code.toString(16).toUpperCase().padStart(4, "0")}`;
    } else {
      out += `\\U${code.toString(16).toUpperCase().padStart(8, "0")}`;
    }
  }
  return `${out}"`;
}

function yamlScalar(value, indent) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);

  const text = String(value);
  const hasBreak = text.includes("\n");
  if (SPECIAL_CHARACTERS.test(text) || text.includes("\t") || (hasBreak && UNFOLDABLE_BREAK.test(text))) {
    return doubleQuoted(text);
  }
  if (hasBreak) {
    // PyYAML folds a run of N breaks into N + 1 newlines plus indentation.
    const folded = text.replace(/\n+/g, (run) => `\n${run}${" ".repeat(indent)}`);
    return `'${folded.replace(/'/g, "''")}'`;
  }
  if (text === "" || PLAIN_UNSAFE.test(text) || NON_STRING_LOOKALIKE.test(text)) {
    return `'${text.replace(/'/g, "''")}'`;
  }
  return text;
}

function toYaml(payload) {
  const lines = [
    `version: ${yamlScalar(payload.version, 2)}`,
    `source: ${yamlScalar(payload.source, 2)}`,
    `generated_at: ${yamlScalar(payload.generated_at, 2)}`,
    payload.reminders.length === 0 ? "reminders: []" : "reminders:",
  ];
  for (const reminder of payload.reminders) {
    Object.entries(reminder).forEach(([key, value], index) => {
      lines.push(`${index === 0 ? "- " : "  "}${key}: ${yamlScalar(value, 4)}`);
    });
  }
  return `${lines.join("\n")}\n`;
}

// Comparison representation: everything except the generated_at line, so a
// run that changed nothing but the clock does not produce a commit.
function comparable(yamlText) {
  return yamlText
    .split("\n")
    .filter((line) => !line.startsWith("generated_at:"))
    .join("\n");
}

// --- Export --------------------------------------------------------------

function selectReminders(reminders, now, includeCompleted) {
  const cutoff = new Date(now.getTime() - COMPLETED_CUTOFF_DAYS * 86400000);

  const selected = reminders
    .filter((reminder) => {
      if (!reminder.dueDate) return false;
      if (!reminder.isCompleted) return true;
      if (!includeCompleted) return false;
      return !!reminder.completionDate && reminder.completionDate > cutoff;
    })
    .map((reminder) => ({
      title: reminder.title || "",
      list: (reminder.calendar && reminder.calendar.title) || "",
      notes: reminder.notes || "",
      created: iso8601(reminder.creationDate),
      due: iso8601(reminder.dueDate),
      completed_at: iso8601(reminder.completionDate),
      priority: reminder.priority || 0,
      flagged: false,
      completed: !!reminder.isCompleted,
    }));

  const sortKeys = ["list", "due", "title", "created", "completed_at"];
  selected.sort((a, b) => {
    for (const key of sortKeys) {
      if (a[key] < b[key]) return -1;
      if (a[key] > b[key]) return 1;
    }
    return 0;
  });
  return selected;
}

async function exportReminders(includeCompleted) {
  const now = new Date();
  log("Fetching reminders…");
  const [incomplete, completed] = await Promise.all([
    Reminder.allIncomplete(),
    Reminder.allCompleted(),
  ]);
  const reminders = incomplete.concat(completed);
  log(`Fetched ${reminders.length} reminders. Filtering and serializing…`);

  const selected = selectReminders(reminders, now, includeCompleted);
  log(`Finished: scanned ${reminders.length} reminders; exported ${selected.length}.`);

  return {
    version: 2,
    source: "eventkit",
    generated_at: iso8601(now),
    reminders: selected,
  };
}

// --- GitHub --------------------------------------------------------------

async function githubRequest(method, url, token, body) {
  const request = new Request(url);
  request.method = method;
  request.headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${token}`,
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "reminders-scriptable-export",
  };
  if (body !== undefined) {
    request.headers["Content-Type"] = "application/json";
    request.body = JSON.stringify(body);
  }
  const json = await request.loadJSON();
  return { status: request.response.statusCode, body: json };
}

async function updateGithubFile(token, yamlText, reminderCount) {
  const escapedPath = FILE_PATH.split("/").map(encodeURIComponent).join("/");
  const endpoint = `${GITHUB_API}/repos/${REPO}/contents/${escapedPath}`;
  const getUrl = `${endpoint}?ref=${encodeURIComponent(BRANCH)}`;
  const encodedPayload = Data.fromString(yamlText).toBase64String();

  log(`Getting current GitHub file: ${REPO}/${FILE_PATH} on ${BRANCH}…`);
  const existing = await githubRequest("GET", getUrl, token);

  if (existing.status === 200) {
    if (existing.body.encoding !== "base64" || !existing.body.content) {
      throw new Error("GitHub did not return Base64 content for the existing reminders file.");
    }
    if (!existing.body.sha) {
      throw new Error("GitHub did not return a SHA for the existing file; refusing to overwrite without it.");
    }
    const remoteText = Data.fromBase64String(
      existing.body.content.replace(/\s/g, "")
    ).toRawString();
    if (comparable(remoteText) === comparable(yamlText)) {
      log("No reminder changes detected; GitHub was not updated.");
      return false;
    }
  } else if (existing.status !== 404) {
    throw new Error(`GitHub API returned HTTP ${existing.status}: ${JSON.stringify(existing.body)}`);
  }

  const creating = existing.status === 404;
  const update = {
    message: `${creating ? "Create" : "Update"} reminders export (${reminderCount} reminders)`,
    content: encodedPayload,
    branch: BRANCH,
  };
  if (!creating) update.sha = existing.body.sha;

  log(`${creating ? "Creating" : "Updating"} GitHub file: ${REPO}/${FILE_PATH} on ${BRANCH}…`);
  const result = await githubRequest("PUT", endpoint, token, update);
  if (result.status !== 200 && result.status !== 201) {
    throw new Error(`Unexpected GitHub update result: HTTP ${result.status}: ${JSON.stringify(result.body)}`);
  }
  log(`GitHub update succeeded. Commit: ${(result.body.commit && result.body.commit.sha) || "unknown"}`);
  return true;
}

async function getToken() {
  if (Keychain.contains(KEYCHAIN_KEY)) {
    return Keychain.get(KEYCHAIN_KEY);
  }
  const alert = new Alert();
  alert.title = "GitHub token";
  alert.message = `Paste a token with write access to ${REPO}. It is stored in the iOS keychain as "${KEYCHAIN_KEY}".`;
  alert.addSecureTextField("github_pat_…");
  alert.addAction("Save");
  alert.addCancelAction("Cancel");
  if ((await alert.presentAlert()) !== 0) {
    throw new Error("No GitHub token provided.");
  }
  const token = alert.textFieldValue(0).trim();
  if (!token) throw new Error("No GitHub token provided.");
  Keychain.set(KEYCHAIN_KEY, token);
  return token;
}

async function main() {
  const payload = await exportReminders(true);
  const yamlText = toYaml(payload);
  const token = await getToken();
  await updateGithubFile(token, yamlText, payload.reminders.length);
}

if (typeof Reminder === "undefined" && typeof module !== "undefined") {
  // Imported outside Scriptable (e.g. by the Node tests).
  module.exports = { toYaml, comparable, selectReminders, yamlScalar, iso8601 };
} else {
  main()
    .then(() => Script.complete())
    .catch((error) => {
      log(`ERROR: ${error.message}`);
      Script.complete();
      throw error;
    });
}
