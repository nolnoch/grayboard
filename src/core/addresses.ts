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
import { SESSION_ID } from "./session_id.ts";
import { CoreError } from "./errors.ts";

export type ParsedAddress =
  | { kind: "id"; address: string }
  | { kind: "team"; address: string; name: string }
  | { kind: "alias"; address: string; scope: string; scopeKind: "person" | "principal"; name: string }
  | { kind: "bare"; address: string; name: string };

/**
 * An address's parts, or null if it isn't one. An alias splits at its first
 * `/` (a scope is one segment, #104 nests by parent, not by path); a scope
 * that is an email makes it a person, one with no `@` a principal (which
 * one, a team or a service, is the Resolver's to say).
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

/** Who owns an alias's scope: a person, a team or a service principal. */
export type ScopeKind = "person" | "team" | "service";

/** An aliases row's scope columns: scope_ref is null only for local mode's implicit person scope. */
export type AliasScope = { scope_kind: ScopeKind; scope_ref: string | null; name: string };

/**
 * Where an alias address sits: a server user's `email/name`, a bare local
 * name, or `scope/name` in a principal's scope. A principal scope's kind
 * comes from `principalKind` (the server's principals table); without it,
 * or for a scope no team or service owns, the address names no alias. An
 * ID or a team broadcast never does.
 */
export function aliasScope(address: string, principalKind?: (name: string) => "team" | "service" | null): AliasScope {
  const p = addressParts(address);
  if (p?.kind === "bare") return { scope_kind: "person", scope_ref: null, name: p.name };
  if (p?.kind === "alias" && p.scopeKind === "person") return { scope_kind: "person", scope_ref: p.scope, name: p.name };
  if (p?.kind === "alias") {
    const kind = principalKind?.(p.scope);
    if (kind) return { scope_kind: kind, scope_ref: p.scope, name: p.name };
    throw new CoreError(`"${address}": no team or service is named "${p.scope}"`);
  }
  throw new CoreError(`"${address}" isn't an alias`);
}
