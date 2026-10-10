// MOBILE_PLAN N3 §3: console.* in src/auth and src/wallet never receives a key-bearing variable. Every console call's
// argument list is extracted; string text is dropped (template `${…}` expressions are kept) and the remaining
// identifiers must not name key material.
import { fs, path, SRC_DIR } from "../node";

const KEYISH = /prf|private|secret|mnemonic|phrase|words|seed|session|signer|account|\bkey\b|handle|entropy/i;

function consoleArgs(src: string): string[] {
  const out: string[] = [];
  const re = /console\s*\.\s*\w+\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    let depth = 1;
    let i = m.index + m[0].length;
    const start = i;
    while (i < src.length && depth > 0) {
      if (src[i] === "(") depth++;
      else if (src[i] === ")") depth--;
      i++;
    }
    out.push(src.slice(start, i - 1));
  }
  return out;
}

/** Remove string literal text but keep template expressions. */
function codeOnly(args: string): string {
  return args
    .replace(/`(?:[^`\\]|\\.)*`/g, (t) => (t.match(/\$\{[^}]*\}/g) ?? []).join(" "))
    .replace(/"(?:[^"\\]|\\.)*"/g, "")
    .replace(/'(?:[^'\\]|\\.)*'/g, "");
}

it("the extractor sees through templates", () => {
  expect(codeOnly('`prf is ${ctx.rpId}` + "privateKey"')).toBe("${ctx.rpId} + ");
  expect(KEYISH.test(codeOnly("`x ${prf}`"))).toBe(true);
});

for (const dir of ["auth", "wallet"]) {
  it(`no key-bearing value reaches console.* in src/${dir}`, () => {
    const root = path.join(SRC_DIR, dir);
    for (const f of fs.readdirSync(root).filter((x) => /\.(ts|tsx)$/.test(x))) {
      for (const a of consoleArgs(fs.readFileSync(path.join(root, f), "utf8"))) expect([f, a, KEYISH.test(codeOnly(a))]).toEqual([f, a, false]);
    }
  });
}
