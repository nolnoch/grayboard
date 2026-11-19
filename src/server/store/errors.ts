// Store refusals shared by the SQLite store (db.ts) and the Postgres store (store/pg/), so the Postgres store never
// imports db.ts, which imports bun:sqlite and goes at P5 (#807).

// A revoke that would leave a team with members and no owner, or a service with no owner at all (#270 D1: every
// service has an owner binding held by a user). `scope` is the team's or service's name.
export class LastOwner extends Error {
  constructor(readonly scope: string, readonly kind: "team" | "service") {
    super(kind === "team"
      ? `the last owner of team "${scope}" can't leave while others remain; make another member an owner first: grayboard team add ${scope} <email> --role owner`
      : `service "${scope}" must keep an owner; grant another first: grayboard admin role grant service_owner <email> --scope ${scope}`);
  }
}

export class PrincipalTaken extends Error {
  constructor(readonly name: string) {
    super(`the name "${name}" belongs to another team or service principal`);
  }
}

// A membership change whose actor no longer holds the authority the route's decision found (their team_owner or
// org_admin binding), re-checked in the store under the role write (#807 P3 C3b): revocation is strict for
// membership as for grants, so an owner revoked mid-request adds or removes no one.
export class AuthorityLost extends Error {
  constructor() {
    super("the role that allowed this membership change is no longer held");
  }
}
