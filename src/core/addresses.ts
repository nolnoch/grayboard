// The address grammar of #284 (decision 16), for both modes:
//
//   address  = agent-id / alias / team / bare
//   agent-id = "id:" 13crockford
//   alias    = scope "/" name        ; scope: an email (a person) or a principal name
//   team     = "team:" name          ; a broadcast to the team's members
//   bare     = name                  ; local mode's aliases, in its one implicit person scope
//
// The name rule itself (`[a-z0-9_-]{1,32}`) lives in src/shared/addressing.ts.
import { isValidEmail, isValidIdentityName } from "../shared/addressing.ts";
import { SESSION_ID } from "./bindings.ts";
import { CoreError } from "./errors.ts";

export type ParsedAddress =
  | { kind: "id"; address: string }
  | { kind: "team"; address: string; name: string }
  | { kind: "alias"; address: string; scope: string; scopeKind: "person" | "principal"; name: string }
  | { kind: "bare"; address: string; name: string };

/**
 * An address's parts, or null if it isn't one. An alias splits at its first
 * `/` (a scope is one segment, #104 nests by parent, not by path); a scope
 * that is an email makes it a person, one with no `@` a principal. The
 * server's wire addresses (user and team) parse in src/shared/addressing.ts.
 */
export function addressParts(input: string): ParsedAddress | null {
  const s = input.toLowerCase();
  if (SESSION_ID.test(s)) return { kind: "id", address: s };
  if (s.startsWith("team:")) {
    const name = s.slice(5);
    return isValidIdentityName(name) ? { kind: "team", address: s, name } : null;
  }
  const slash = s.indexOf("/");
  if (slash === -1) return isValidIdentityName(s) ? { kind: "bare", address: s, name: s } : null;
  const scope = s.slice(0, slash);
  const name = s.slice(slash + 1);
  if (!scope || !isValidIdentityName(name)) return null;
  if (isValidEmail(scope)) return { kind: "alias", address: s, scope, scopeKind: "person", name };
  return scope.includes("@") ? null : { kind: "alias", address: s, scope, scopeKind: "principal", name };
}

/** An aliases row's scope columns: a person scope (an email), or null for local mode's implicit one. */
export type AliasScope = { scope_kind: "person"; scope_ref: string | null; name: string };

/**
 * Where an alias address sits. Every alias written so far is a person's:
 * a server user's `email/name`, or a bare local name. An ID, a team
 * broadcast or a principal scope can't name one here.
 */
export function aliasScope(address: string): AliasScope {
  const p = addressParts(address);
  if (p?.kind === "bare") return { scope_kind: "person", scope_ref: null, name: p.name };
  if (p?.kind === "alias" && p.scopeKind === "person") return { scope_kind: "person", scope_ref: p.scope, name: p.name };
  throw new CoreError(`"${address}" isn't a person's alias`);
}
