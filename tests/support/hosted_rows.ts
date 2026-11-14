// Every hosted_sessions row, parked children included (#584): `repo.hosted.all()` leaves parked children out, so a
// deletion assert on it would also pass with a parked row left behind.
export const hostedRowCount = (db: { query(sql: string): { get(): unknown } }) =>
  (db.query("SELECT count(*) AS n FROM hosted_sessions").get() as { n: number }).n;

