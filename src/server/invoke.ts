// service.invoke (#270 D6): a post on a service's board is an invocation, decided for the acting address's principal
// (a team-scoped name's is the team: `principalOf`) on the post's own transaction, with no cache (principle 11;
// server-access.md §1). The caller records the decision: an allow on the write it carries, since an invocation
// exercises a grant (principle 8), a deny after the rollback. A deny answers exactly as a missing board does
// (principle 9). The server only decides who may post; the post is ordinary queue work a service lane claims, so
// grayboard never dispatches to the service (principle 7).
import { addressParts } from "../core/addresses.ts";
import { normalizeBoard } from "../core/boards.ts";
import { CoreError } from "../core/errors.ts";
import type { Repo } from "./db.ts";
import { authorize, serviceOfScope, type AuthzRequest, type Decision } from "./policy.ts";
import type { Read } from "./store/tx.ts";

export type Invocation = { req: Extract<AuthzRequest, { verb: "service.invoke" }>; d: Decision };

// The decision for `actor` posting on board `input`, or null when the board isn't a service's (or doesn't exist, or
// its name is invalid: the post's own gate refuses those as it always has). A session's ID acts as its user on every
// other board, so a session bound only to `eng/w-1` would otherwise invoke through its user's own grant whenever the
// actor fell back to its ID; here an ID is judged as its session's `primary` (its oldest hold), so that session holds
// the right only by eng's binding (D6, Tests item 4). An unbound session's primary is its ID: its user's.
export async function invocation(repo: Repo, r: Read, actor: string, input: unknown, primary: string): Promise<Invocation | null> {
  if (typeof input !== "string") return null;
  let name: string;
  try { name = normalizeBoard(input); } catch { return null; }
  const service = serviceOfScope((await repo.boards.get(r, name))?.scope ?? null);
  if (service === null) return null;
  const req = { verb: "service.invoke" as const, principal: await repo.principals.of(r, addressParts(actor)?.kind === "id" ? primary : actor), service, board: name };
  return { req, d: await authorize(repo, r, {}, req) };
}

// The refusal a denied invocation answers with: readableBoard's for a board that doesn't exist or can't be seen.
export const hiddenBoard = (inv: Invocation): CoreError => new CoreError(`no such board #${inv.req.board}; see board_list`);
