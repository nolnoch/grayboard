// Fan-out (docs/factory.md §7): a fleet task's one run either does the
// task or returns a plan of independent subtasks. The model judges; this
// code orchestrates. The plan is a fenced JSON block whose info string is
// `factory-plan`, four backticks like a delegation's payload, so a subtask
// carrying ordinary code fences still parses.
import { DATA_FENCE } from "./delegate.ts";

export type Subtask = { title: string; task: string };
export type Plan = { subtasks: Subtask[] };

const OPEN = `${DATA_FENCE}factory-plan\n`;
const MAX_TITLE = 120;
// What a synthesis run reads of each subtask's outcome: enough to combine,
// bounded so n subtasks can't blow the prompt up.
const MAX_RESULT_CHARS = 16 * 1024;

// Appended to a fan-out-capable task. Doing the task is the default; a plan
// is for work that splits into parts worth running in parallel.
export function triageInstruction(max: number): string {
  return [
    "## Before you start",
    "",
    `If this task splits into 2 to ${max} independent parts that separate agents could do in parallel, and doing it that way is clearly better, don't do the task. Reply with only a plan, in exactly this form:`,
    "",
    `${OPEN}{"subtasks": [{"title": "a short title", "task": "everything that agent needs: it sees only its own task text"}]}`,
    DATA_FENCE,
    "",
    "Each subtask's agent has the same tools and working directory as you, and none of this conversation. Otherwise, do the task yourself and reply with the result.",
  ].join("\n");
}

// The plan in a run's output: null when there is none (the run did the
// task), an error string when the block is there but unusable.
export function parsePlan(text: string, max: number): Plan | string | null {
  const at = text.indexOf(OPEN);
  if (at < 0 || (at > 0 && text[at - 1] !== "\n")) return null;
  const start = at + OPEN.length;
  const end = text.indexOf(`\n${DATA_FENCE}`, start);
  if (end < 0) return "the plan block isn't closed";
  let data: unknown;
  try { data = JSON.parse(text.slice(start, end)); } catch { return "the plan isn't valid JSON"; }
  const list = (data as { subtasks?: unknown } | null)?.subtasks;
  if (!Array.isArray(list)) return `the plan has no "subtasks" array`;
  if (list.length < 2 || list.length > max) return `the plan has ${list.length} subtasks; it needs 2 to ${max}`;
  const subtasks: Subtask[] = [];
  for (const [i, s] of list.entries()) {
    const t = s as { title?: unknown; task?: unknown } | null;
    if (typeof t?.title !== "string" || !t.title.trim() || typeof t.task !== "string" || !t.task.trim()) return `subtask ${i + 1} needs a non-empty "title" and "task"`;
    subtasks.push({ title: t.title.replace(/[\r\n]+/g, " ").trim().slice(0, MAX_TITLE), task: t.task.trim() });
  }
  return { subtasks };
}

// The synthesis run's prompt: the original task, each subtask's outcome
// (done or failed, as replied in its thread), and what to do with them.
export function synthesisPrompt(task: string, results: { title: string; reply: string | null }[]): string {
  const parts = results.map((r, i) => {
    const body = r.reply ?? "(no outcome)";
    const clipped = body.length > MAX_RESULT_CHARS ? `${body.slice(0, MAX_RESULT_CHARS)}\n\n(result truncated at ${MAX_RESULT_CHARS} characters)` : body;
    return `### ${i + 1}. ${r.title}\n\n${clipped}`;
  });
  return [
    task,
    "",
    "## Subtask results",
    "",
    "This task was split into the subtasks below, each run by a separate agent. Their outcomes follow.",
    "",
    parts.join("\n\n"),
    "",
    "## What to do",
    "",
    "Combine these results into one answer to the task. Say plainly where a subtask failed or left out something the task needs. Don't split the task again.",
  ].join("\n");
}
