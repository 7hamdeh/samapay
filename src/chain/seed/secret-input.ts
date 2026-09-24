// Hidden input for the seed-import and vault-proof CLIs (contract §8.1–8.2).
//
// ECHO OFF IS A MECHANISM HERE, NOT A PROMISE: the terminal is put in RAW mode
// (setRawMode(true)), which turns the tty line discipline's own echo off, and
// this reader writes NOTHING per keystroke — not the character, not a mask.
// The typed text exists only in the returned string; it is never logged,
// never placed in argv or env, never written to any stream.
//
// requireInteractiveTerminal() is the first statement of both CLIs, before any
// import that could open a database connection: a pipe, a file or an agent's
// captured stdin/stdout is refused outright.
import * as bip39 from "bip39";

export class InputAborted extends Error {
  constructor() {
    super("input aborted at the terminal");
    this.name = "InputAborted";
  }
}

/** Refuses (exit 1) unless BOTH stdin and stdout are a TTY. Call before touching anything else. */
export function requireInteractiveTerminal(): void {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("REFUSING: not an interactive terminal (stdin and stdout must both be a TTY).");
    console.error("Run this yourself, directly in a terminal — never through a pipe, a file, or an agent.");
    process.exit(1);
  }
}

/**
 * Reads one line from the TTY with echo OFF. Enter ends the line; Backspace
 * edits; Ctrl-C / Ctrl-D abort (InputAborted). Escape sequences (arrow keys,
 * bracketed-paste markers) are dropped, never inserted.
 */
export function readHiddenLine(prompt: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!input.isTTY) {
      reject(new Error("readHiddenLine: input is not a TTY"));
      return;
    }
    output.write(prompt);
    let buf = "";
    input.setRawMode(true);
    input.resume();
    const finish = (err: Error | null) => {
      input.removeListener("data", onData);
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      if (err) reject(err);
      else resolve(buf);
    };
    const onData = (chunk: Buffer) => {
      const s = chunk.toString("utf8").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\x1b./g, "");
      for (const ch of s) {
        if (ch === "\r" || ch === "\n") return finish(null);
        if (ch === "\x03" || ch === "\x04") return finish(new InputAborted());
        if (ch === "\x7f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        if (ch < " ") continue;
        buf += ch;
      }
    };
    input.on("data", onData);
  });
}

const WORDS = new Set(bip39.wordlists.english ?? []);

/**
 * Collects exactly `count` BIP39 words, one prompt at a time ("word N of 24: ").
 * A line may hold several words (all are checked). A token outside the English
 * list is refused by POSITION only — the word itself is never printed — and
 * that position is asked for again. `say` receives status lines only.
 */
export async function collectMnemonicWords(ask: (prompt: string) => Promise<string>, say: (line: string) => void, count: number): Promise<string[]> {
  const words: string[] = [];
  while (words.length < count) {
    const line = await ask(`word ${words.length + 1} of ${count}: `);
    const tokens = line.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0) continue;
    const firstBad = tokens.findIndex((t) => !WORDS.has(t));
    if (firstBad !== -1) {
      say(`  word ${words.length + firstBad + 1} is not in the BIP39 English word list — type it again (from word ${words.length + 1}).\n`);
      continue;
    }
    if (words.length + tokens.length > count) {
      say(`  that line would make more than ${count} words — type it again (from word ${words.length + 1}).\n`);
      continue;
    }
    words.push(...tokens);
  }
  return words;
}
