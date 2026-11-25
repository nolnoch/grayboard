// The authority a decision carries into its write (#927): the in-write re-check is only as good as this mapping. An
// owner's `team add --role owner` that mapped to "none" would skip the re-check, which only a Postgres interleaving
// could otherwise catch.
import { expect, test } from "bun:test";
import { authorityOf } from "./roles.ts";

test("authorityOf maps each allowing rule to the authority its write re-checks", () => {
  expect(authorityOf({ allow: true, rule: "admin.env" })).toBe("none");
  expect(authorityOf({ allow: true, rule: "role.org_admin", binding: 1 })).toBe("org_admin");
  expect(authorityOf({ allow: true, rule: "role.team_owner", binding: 2 })).toBe("owner_or_admin");
  expect(authorityOf({ allow: true, rule: "team.member" })).toBe("none");
});
