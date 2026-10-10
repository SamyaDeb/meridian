// Maestro can't run in CI here, so this keeps mobile/.maestro honest: every flow parses (a minimal line parser: `yaml`
// isn't a mobile dependency), runs in config.yaml's order, and every `id:` it taps or waits for exists as a testID in
// mobile/src. testIDs are collected from literals (`testID="x"`, `testID: "x"`, defaults `testID = "x"`), templates
// (`position-${v.venue}-close` ⇒ one word per `${…}`) and pass-through suffixes (`${testID}-tap` on ConfirmBar ⇒
// "<any literal>-tap").
import { fs, path, sourceFiles, SRC_DIR } from "./node";

const MAESTRO_DIR = path.join(SRC_DIR, "..", ".maestro");
const WORD = "[A-Za-z0-9_.]+";
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

type Flow = { file: string; ids: string[]; texts: string[]; subflows: string[]; appId: string | undefined };

/** `env:` defaults in the header (before `---`) and every `id:` / `text:` / `runFlow:` after it. */
export function parseFlow(file: string, src: string): Flow {
  const [head, body] = src.includes("\n---") ? [src.slice(0, src.indexOf("\n---")), src.slice(src.indexOf("\n---") + 4)] : ["", src];
  const env: Record<string, string> = {};
  let inEnv = false;
  let appId: string | undefined;
  for (const line of head.split("\n")) {
    if (/^\S/.test(line)) inEnv = /^env:\s*$/.test(line);
    const a = /^appId:\s*(.+?)\s*$/.exec(line);
    if (a) appId = a[1];
    const kv = inEnv ? /^\s+([A-Z_][A-Z0-9_]*):\s*"?([^"#]*?)"?\s*$/.exec(line) : null;
    if (kv) env[kv[1]!] = kv[2]!;
  }
  const sub = (v: string) => v.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (m, k: string) => env[k] ?? m);
  const val = (line: string, key: string) => {
    const m = new RegExp(`^\\s*(?:-\\s*)?${key}:\\s*(.+?)\\s*$`).exec(line);
    return m ? sub(m[1]!.replace(/^["']|["']$/g, "")) : undefined;
  };
  const ids: string[] = [];
  const texts: string[] = [];
  const subflows: string[] = [];
  for (const line of body.split("\n")) {
    if (/^\s*#/.test(line)) continue;
    const id = val(line, "id");
    if (id !== undefined) ids.push(id);
    const text = val(line, "text");
    if (text !== undefined) texts.push(text);
    const rf = val(line, "runFlow");
    if (rf !== undefined && rf !== "") subflows.push(rf);
  }
  return { file, ids, texts, subflows, appId };
}

/** Every testID the app can render, as anchored regexes. */
function testIdMatchers(): RegExp[] {
  const literals = new Set<string>();
  const templates: string[] = [];
  const suffixes: string[] = [];
  const re = /(?:testID|tabBarButtonTestID)\s*(?:=|:)\s*\{?\s*(?:"([^"]+)"|'([^']+)'|`([^`]+)`)/g;
  for (const f of sourceFiles()) {
    const s = fs.readFileSync(f, "utf8");
    for (const m of s.matchAll(re)) {
      const v = m[1] ?? m[2] ?? m[3]!;
      if (!v.includes("${")) literals.add(v);
      else if (v.startsWith("${testID}")) suffixes.push(v.slice("${testID}".length));
      else templates.push(v);
    }
  }
  const tpl = (t: string) => t.split(/\$\{[^}]+\}/).map(esc).join(WORD);
  const out = [...literals].map((l) => new RegExp(`^${esc(l)}$`));
  for (const t of templates) out.push(new RegExp(`^${tpl(t)}$`));
  // a component's own testID prop + its suffix (ConfirmBar "-tap", Numpad "-key-5", LeftoverClose "-close", …)
  for (const sfx of suffixes) for (const l of literals) out.push(new RegExp(`^${esc(l)}${tpl(sfx)}$`));
  return out;
}

const flowFiles = (dir: string): string[] =>
  fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) return flowFiles(p);
    return f.endsWith(".yaml") && f !== "config.yaml" ? [p] : [];
  });

const FLOWS = flowFiles(MAESTRO_DIR).map((p) => parseFlow(p.slice(MAESTRO_DIR.length + 1), fs.readFileSync(p, "utf8")));
const MATCHERS = testIdMatchers();

it("the four N8 flows exist and config.yaml runs them in order", () => {
  const top = FLOWS.filter((f) => !f.file.includes(path.sep)).map((f) => f.file);
  for (const f of ["onboarding.yaml", "trade-open-close.yaml", "earn-open-close.yaml", "close-all.yaml"]) expect(top).toContain(f);
  const cfg = fs.readFileSync(path.join(MAESTRO_DIR, "config.yaml"), "utf8");
  const order = [...cfg.matchAll(/^\s+-\s+([a-z-]+)\s*$/gm)].map((m) => m[1]);
  expect(order).toEqual(["onboarding", "trade-open-close", "earn-open-close", "close-all"]);
  // the app ids in the config comment are the ones the app builds with (src/config/appConfig.ts)
  const ids = fs.readFileSync(path.join(SRC_DIR, "config", "appConfig.ts"), "utf8");
  for (const pkg of ["xyz.meridianfi.app.staging", "xyz.meridianfi.app"]) {
    expect(cfg).toContain(pkg);
    expect(ids).toContain(`"${pkg}"`);
  }
});

describe.each(FLOWS.map((f) => [f.file, f] as const))("%s", (_name, flow) => {
  it("has an appId (passed with -e APP_ID); a top-level flow references at least one id", () => {
    expect(flow.appId).toBe("${APP_ID}");
    if (!flow.file.includes(path.sep)) expect(flow.ids.length).toBeGreaterThan(0);
  });
  it("every id: exists as a testID in mobile/src", () => {
    const missing = flow.ids.filter((id) => !MATCHERS.some((m) => m.test(id)));
    expect(missing).toEqual([]);
  });
  it("no unresolved ${VAR} in an id, and every runFlow file exists", () => {
    expect(flow.ids.filter((id) => id.includes("${"))).toEqual([]);
    for (const sf of flow.subflows) expect(() => fs.statSync(path.join(MAESTRO_DIR, sf))).not.toThrow();
  });
});

it("the checker itself catches a missing id", () => {
  const f = parseFlow("x.yaml", 'appId: ${APP_ID}\nenv:\n  VENUE: perpl\n---\n- tapOn:\n    id: "position-${VENUE}-close"\n- tapOn:\n    id: "no-such-button"\n');
  expect(f.ids).toEqual(["position-perpl-close", "no-such-button"]);
  expect(f.ids.map((id) => MATCHERS.some((m) => m.test(id)))).toEqual([true, false]);
});
