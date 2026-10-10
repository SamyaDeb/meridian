// Jest runs on Node, but mobile's tsconfig carries no Node types (the app is Hermes). The static scans need three fs
// calls and a path join: typed here, loaded with require at test time only.
type Fs = { readFileSync(p: string, enc: "utf8"): string; readdirSync(p: string): string[]; statSync(p: string): { isDirectory(): boolean } };
type Path = { join(...p: string[]): string; sep: string };

declare const __dirname: string;

export const fs = require("node:fs") as Fs;
export const path = require("node:path") as Path;
/** absolute path of mobile/src */
export const SRC_DIR: string = path.join(__dirname, "..");

/** every .ts/.tsx under `dir`, skipping __tests__ */
export function sourceFiles(dir: string = SRC_DIR): string[] {
  return fs.readdirSync(dir).flatMap((f) => {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) return f === "__tests__" ? [] : sourceFiles(p);
    return /\.(ts|tsx)$/.test(f) ? [p] : [];
  });
}
