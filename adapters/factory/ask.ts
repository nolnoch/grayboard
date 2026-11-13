// Asking (#652, docs/factory.md §8): a run that can't finish without a fact
// or a decision only a person can give ends with a question instead of a
// guess. Like a plan (fanout.ts), the question is a fenced JSON block that
// is the whole reply, info string `factory-ask`, four backticks. Code parses
// it; the row parks until an answer comes, then the same conversation
// resumes with the answer as its next prompt.
import { DATA_FENCE } from "./delegate.ts";

export type Ask = { question: string; human: boolean };

const OPEN = `${DATA_FENCE}factory-ask\n`;
// A question goes in a reply with its header; keep it well under a body's 64 KiB.
const MAX_QUESTION_BYTES = 8 * 1024;

// Appended to every run's prompt (not a resume's: the conversation has it).
export function askInstruction(): string {
  return [
    "## If you need an answer",
    "",
    "If you can't finish without a fact or a decision only a person can give, and a guess would waste the work, stop and reply with only:",
    "",
    `${OPEN}{"question": "one clear question, with the options you see"}`,
    DATA_FENCE,
    "",
    `The person who asked answers it, and you continue from here with their answer. For a product decision only the user can make, add \`"to": "human"\`. Ask only when it matters; otherwise use your judgement.`,
  ].join("\n");
}

// The question in a run's output: null when there is none, an error string
// when the block is there but unusable. The block is the whole reply, so an
// answer that quotes one is an answer.
export function parseAsk(text: string): Ask | string | null {
  const t = text.trim();
  if (!t.startsWith(OPEN)) return null;
  const end = t.indexOf(`\n${DATA_FENCE}`, OPEN.length);
  if (end < 0) return "the question block isn't closed";
  let data: unknown;
  try { data = JSON.parse(t.slice(OPEN.length, end)); } catch { return "the question isn't valid JSON"; }
  const d = data as { question?: unknown; to?: unknown } | null;
  if (typeof d?.question !== "string" || !d.question.trim()) return `the block has no "question"`;
  if (new TextEncoder().encode(d.question).length > MAX_QUESTION_BYTES) return `the question is over ${MAX_QUESTION_BYTES / 1024} KiB`;
  if (d.to !== undefined && d.to !== "human") return `"to" may only be "human"`;
  return { question: d.question.trim(), human: d.to === "human" };
}

// What a resumed run reads as its next prompt.
export const answerPrompt = (who: string, text: string) => `The answer to your question, from ${who}:\n\n${text}\n\nContinue the task.`;
export const NO_ANSWER = "No one answered your question in time. Continue with your own judgement, or end with a failure that says what you needed.";
export const NO_MORE = "No more questions are allowed for this task. Decide yourself, or end with a failure that says what you needed.";

// A run with no session to resume (its runner reported none): a fresh run
// of the original input, told what it asked and what came back.
export const reseeded = (task: string, question: string, answer: string) => `${task}\n\n## Your earlier question\n\nAn earlier run of this task stopped to ask:\n\n${question}\n\n${answer}`;
