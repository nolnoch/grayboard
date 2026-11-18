// Store refusals shared by the SQLite store (db.ts) and the Postgres store (store/pg/), so the Postgres store never
// imports db.ts, which imports bun:sqlite and goes at P5 (#807).

export class LastOwner extends Error {
  constructor(readonly team: string) {
    super(`the last owner of team "${team}" can't leave while others remain; make another member an owner first: grayboard team add ${team} <email> --role owner`);
  }
}

export class PrincipalTaken extends Error {
  constructor(readonly name: string) {
    super(`the name "${name}" belongs to another team or service principal`);
  }
}
