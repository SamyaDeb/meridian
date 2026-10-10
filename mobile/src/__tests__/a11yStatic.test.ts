// N8 D4.5: every tappable in mobile/src speaks. A static scan of the JSX: each <Pressable>, <TouchableOpacity>,
// <TouchableHighlight> has an accessibilityLabel or a visible <Text> child, and each design-system <Button> has a
// `title` (Button turns it into the label). Gesture-only controls are covered by SwipeRow's own fallback buttons.
import { fs, SRC_DIR, sourceFiles } from "./node";

const TAGS = ["Pressable", "TouchableOpacity", "TouchableHighlight", "Button"] as const;

/** The opening tag starting at `i` (handles {…} expressions, strings and arrow functions inside attributes). */
export function openingTag(src: string, i: number): string {
  let depth = 0;
  let quote: string | undefined;
  for (let j = i + 1; j < src.length; j++) {
    const c = src[j]!;
    if (quote) {
      if (c === quote && src[j - 1] !== "\\") quote = undefined;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "{") depth++;
    else if (c === "}") depth--;
    else if (c === ">" && depth === 0) return src.slice(i, j + 1);
  }
  throw new Error(`unterminated tag at ${i}`);
}

export type Finding = { file: string; line: number; tag: string };

export function unlabeled(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const re = new RegExp(`<(${TAGS.join("|")})(?=[\\s/>])`, "g");
  for (const m of src.matchAll(re)) {
    const tag = m[1]!;
    const open = openingTag(src, m.index);
    const line = src.slice(0, m.index).split("\n").length;
    if (tag === "Button") {
      if (!/\btitle=/.test(open)) out.push({ file, line, tag });
      continue;
    }
    if (/\baccessibilityLabel=/.test(open)) continue;
    if (open.endsWith("/>")) {
      out.push({ file, line, tag });
      continue;
    }
    const close = src.indexOf(`</${tag}>`, m.index + open.length);
    const body = close < 0 ? "" : src.slice(m.index + open.length, close);
    if (!/<Text\b[^>]*>\s*[^<\s]/.test(body) && !/<Text\b[^>]*>\s*\{/.test(body)) out.push({ file, line, tag });
  }
  return out;
}

it("every Pressable / Touchable has an accessibilityLabel or a visible Text child; every Button has a title", () => {
  const files = sourceFiles();
  const found = files.flatMap((f) => unlabeled(f.slice(SRC_DIR.length + 1), fs.readFileSync(f, "utf8")));
  expect(found).toEqual([]);
  // not vacuous: the scan visits every tappable in the app (84 on 10 Oct; grows with the app)
  const visited = files.reduce((n, f) => n + [...fs.readFileSync(f, "utf8").matchAll(new RegExp(`<(${TAGS.join("|")})(?=[\\s/>])`, "g"))].length, 0);
  expect(visited).toBeGreaterThanOrEqual(84);
});

it("the scanner flags what it should and passes what it should", () => {
  const src = [
    `<Pressable onPress={() => a > b && go()} style={s.x} />`, // flagged: no label, no child
    `<Pressable accessibilityLabel="Close" onPress={x} />`,
    `<Pressable onPress={x}><Text bold>Close</Text></Pressable>`,
    `<Pressable onPress={x}><Text>{label}</Text></Pressable>`,
    `<Pressable onPress={x}><View style={s.dot} /></Pressable>`, // flagged: an icon only
    `<TouchableOpacity onPress={x}><Icon /></TouchableOpacity>`, // flagged
    `<Button title="Done" onPress={x} />`,
    `<Button onPress={x} />`, // flagged
  ].join("\n");
  expect(unlabeled("x.tsx", src).map((f) => `${f.line}:${f.tag}`)).toEqual(["1:Pressable", "5:Pressable", "6:TouchableOpacity", "8:Button"]);
});
