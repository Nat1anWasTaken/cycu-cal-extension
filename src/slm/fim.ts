// Qwen2.5-Coder fill-in-the-middle prompt building and completion post-processing.
//
// Pure functions with no runtime imports, so the content script, the offscreen host and
// `node --test` (type stripping) can all use them.
//
// HARD PRODUCT RULE: the prompt is built ONLY from the editor text before and after the
// cursor. Never pass the problem statement or any other page content in here.

export const FIM_PREFIX = '<|fim_prefix|>';
export const FIM_SUFFIX = '<|fim_suffix|>';
export const FIM_MIDDLE = '<|fim_middle|>';
export const FIM_PAD = '<|fim_pad|>';
export const END_OF_TEXT = '<|endoftext|>';
export const REPO_NAME = '<|repo_name|>';
export const FILE_SEP = '<|file_sep|>';

/** Every control token that must end a completion (and never appear in editor text). */
export const SPECIAL_TOKENS = [
  END_OF_TEXT,
  FIM_PAD,
  FIM_PREFIX,
  FIM_SUFFIX,
  FIM_MIDDLE,
  REPO_NAME,
  FILE_SEP,
  '<|im_end|>',
  '<|im_start|>',
];

/** Stop strings handed to the sampler. Blank lines with whitespace and dedents are handled by postprocess(). */
export const STOP_SEQUENCES = [...SPECIAL_TOKENS, '\n\n'];

/** Rough code-tokens estimate for the Qwen2.5 tokenizer (conservative, so the real count stays under the cap). */
export const CHARS_PER_TOKEN = 3;
export const DEFAULT_MAX_CONTEXT_TOKENS = 1536;
/** Share of the context budget given to the prefix when both sides are long. */
export const PREFIX_SHARE = 0.75;

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Removes control-token look-alikes typed into the editor so they cannot break the prompt structure. */
export function sanitize(text: string): string {
  let out = text;
  for (const t of SPECIAL_TOKENS) out = out.split(t).join('');
  return out;
}

/** Keeps whole lines from the end of `text` within `budget` chars; the last (cursor) line is always kept, char-trimmed if huge. */
function takeTail(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const lines = text.split('\n');
  const last = lines.pop() as string;
  if (last.length >= budget) return last.slice(last.length - Math.max(0, budget));
  let used = last.length;
  let start = lines.length;
  while (start > 0 && used + lines[start - 1].length + 1 <= budget) {
    start--;
    used += lines[start].length + 1;
  }
  return [...lines.slice(start), last].join('\n');
}

/** Keeps whole lines from the start of `text` within `budget` chars; the first (cursor) line is always kept, char-trimmed if huge. */
function takeHead(text: string, budget: number): string {
  if (text.length <= budget) return text;
  const lines = text.split('\n');
  const first = lines.shift() as string;
  if (first.length >= budget) return first.slice(0, Math.max(0, budget));
  let used = first.length;
  let end = 0;
  while (end < lines.length && used + lines[end].length + 1 <= budget) {
    used += lines[end].length + 1;
    end++;
  }
  return [first, ...lines.slice(0, end)].join('\n');
}

/**
 * Trims the far ends of the context to about `maxTokens` tokens, dropping whole lines
 * (furthest from the cursor first). The prefix gets PREFIX_SHARE of the budget, and
 * whatever one side does not need goes to the other.
 */
export function trimContext(
  prefix: string,
  suffix: string,
  maxTokens: number = DEFAULT_MAX_CONTEXT_TOKENS,
): { prefix: string; suffix: string } {
  const budget = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (prefix.length + suffix.length <= budget) return { prefix, suffix };
  const suffixBudget = Math.floor(budget * (1 - PREFIX_SHARE));
  const s0 = takeHead(suffix, suffixBudget);
  const p = takeTail(prefix, budget - s0.length);
  const s = takeHead(suffix, budget - p.length);
  return { prefix: p, suffix: s };
}

/** `<|fim_prefix|>{prefix}<|fim_suffix|>{suffix}<|fim_middle|>`, sanitized and trimmed. */
export function buildFimPrompt(prefix: string, suffix: string, maxTokens: number = DEFAULT_MAX_CONTEXT_TOKENS): string {
  const t = trimContext(sanitize(prefix), sanitize(suffix), maxTokens);
  return FIM_PREFIX + t.prefix + FIM_SUFFIX + t.suffix + FIM_MIDDLE;
}

// ---------------------------------------------------------------------------
// Post-processing / stop conditions
// ---------------------------------------------------------------------------

export interface CursorContext {
  /** Text of the cursor line before the cursor. */
  linePrefix: string;
  /** Text of the cursor line after the cursor. */
  lineSuffix: string;
  /** Indent width (columns) of the cursor line. */
  baseIndent: number;
  /** Lines of the suffix after the cursor line. */
  nextLines: string[];
  tabSize: number;
  /** Real code follows the cursor on its line: complete a single line only. */
  singleLine: boolean;
}

export function indentWidth(line: string, tabSize: number): number {
  let w = 0;
  for (const ch of line) {
    if (ch === ' ') w++;
    else if (ch === '\t') w += tabSize - (w % tabSize);
    else break;
  }
  return w;
}

export function cursorContext(prefix: string, suffix: string, tabSize = 2): CursorContext {
  const linePrefix = prefix.slice(prefix.lastIndexOf('\n') + 1);
  const nl = suffix.indexOf('\n');
  const lineSuffix = nl < 0 ? suffix : suffix.slice(0, nl);
  const nextLines = nl < 0 ? [] : suffix.slice(nl + 1).split('\n');
  return {
    linePrefix,
    lineSuffix,
    baseIndent: indentWidth(linePrefix + lineSuffix, tabSize),
    nextLines,
    tabSize,
    // Only closing punctuation after the cursor (e.g. an auto-closed `}` or `);`) still allows multi-line.
    singleLine: /[^\s)\]}>;,'"]/.test(lineSuffix),
  };
}

export interface Processed {
  text: string;
  /** A stop condition was definitively reached: generation can be aborted. */
  done: boolean;
}

/**
 * Applies the stop conditions to the raw generated text. Call it on every streamed
 * chunk with `final=false` (abort when `done`), and once on the full text with `final=true`.
 *
 * Stops at: any special/FIM token, a blank line, a line indented less than the cursor line,
 * or (when code follows the cursor on its line) the first line break.
 */
export function postprocess(raw: string, ctx: CursorContext, final: boolean): Processed {
  let text = raw;
  let done = false;

  // 1. Control tokens.
  let cut = -1;
  for (const t of SPECIAL_TOKENS) {
    const i = text.indexOf(t);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  }
  if (cut >= 0) {
    text = text.slice(0, cut);
    done = true;
  }

  // 2. Line-based conditions.
  const lines = text.split('\n');
  let keep = lines.length;
  // Code before the cursor on its line + the first line finishes a statement: just complete the statement.
  const finishesStatement = lines.length > 1 && ctx.linePrefix.trim() !== '' && /;\s*$/.test(lines[0]);
  if ((ctx.singleLine || finishesStatement) && lines.length > 1) {
    keep = 1;
    done = true;
  } else {
    const seen = new Set<string>([(ctx.linePrefix + lines[0]).trim()]);
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i];
      const complete = i < lines.length - 1 || done || final;
      const key = line.trim();
      // Greedy decoding loops: stop when a substantial line repeats within the completion.
      if (complete && key.length >= 4 && /\w/.test(key)) {
        if (seen.has(key)) {
          keep = i;
          done = true;
          break;
        }
        seen.add(key);
      }
      if (line.trim() === '') {
        // A blank line is definitive once a line break follows it; a trailing one may still grow.
        if (i < lines.length - 1) {
          keep = i;
          done = true;
          break;
        }
        continue;
      }
      // Indentation is only known once the line has a non-whitespace char.
      if (indentWidth(line, ctx.tabSize) < ctx.baseIndent) {
        keep = i;
        done = true;
        break;
      }
    }
  }
  text = lines.slice(0, keep).join('\n');

  if (final || done) {
    const out = text.split('\n');
    // Drop a trailing line the suffix already starts with (the model re-emitting code below the cursor).
    const next = ctx.nextLines.find((l) => l.trim() !== '');
    if (out.length > 1 && next !== undefined && out[out.length - 1].trim() === next.trim()) out.pop();
    // A trailing whitespace-only line is noise unless it pushes existing text (lineSuffix) to its own line.
    if (out.length > 1 && out[out.length - 1].trim() === '' && ctx.lineSuffix.trim() === '') out.pop();
    text = out.join('\n');
    if (ctx.lineSuffix.trim() === '') text = text.replace(/[ \t]+$/, '');
    if (text.trim() === '') text = '';
  }
  return { text, done };
}
