// Floating promises in the server (#1107, #1115): an expression statement whose value is a promise nobody awaits,
// returns, or hands a rejection handler. On SQLite an async store write runs its SQL before it returns, so a dropped
// `await` passes typecheck and every test; on Postgres the same write runs after its Tx settles, or escapes as an
// unhandled rejection instead of rolling the body back. tests/integration/floating_promises.test.ts runs it against
// the repo, so bun test, the pre-push hook and CI enforce it.
//
//   bun scripts/check_floating_promises.ts [root]   (default: this repo)
//
// Handled, as typescript-eslint's no-floating-promises counts them: `await p`, `void p` (a deliberate fire-and-forget),
// `p.catch(f)`, `p.then(f, g)`, a `.finally(f)` on a handled one, and an assignment. Anything else whose type is thenable (a Promise, or a union with
// one) is reported. Only expression statements are checked: a promise passed as a void callback
// (no-misused-promises) isn't.
import { relative, resolve } from "node:path";
import ts from "typescript";

// The trees checked, from the root: the server, its tests among them.
export const CHECKED = ["src/server/"];

function thenable(checker: ts.TypeChecker, type: ts.Type): boolean {
  if (type.isUnion()) return type.types.some(t => thenable(checker, t));
  const then = type.getProperty("then");
  if (!then) return false;
  const decl = then.valueDeclaration ?? then.declarations?.[0];
  if (!decl) return false;
  return checker.getTypeOfSymbolAtLocation(then, decl).getCallSignatures().length > 0;
}

function handled(expr: ts.Expression): boolean {
  if (ts.isVoidExpression(expr) || ts.isAwaitExpression(expr)) return true;
  if (ts.isBinaryExpression(expr) && expr.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && expr.operatorToken.kind <= ts.SyntaxKind.LastAssignment) return true;
  if (ts.isCallExpression(expr) && ts.isPropertyAccessExpression(expr.expression)) {
    const name = expr.expression.name.text;
    if (name === "catch" && expr.arguments.length >= 1) return true;
    if (name === "then" && expr.arguments.length >= 2) return true;
    // `.finally(f)` passes its receiver's rejection on: handled when the receiver is.
    if (name === "finally") return handled(expr.expression.expression);
  }
  return false;
}

/** Each floating promise under CHECKED, as "path:line: text", for the program `tsconfig` (relative to `root`) builds. */
export function floatingPromises(root: string, tsconfig = "tsconfig.json"): string[] {
  const configPath = resolve(root, tsconfig);
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: d => { throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n")); } });
  if (!parsed) throw new Error(`can't read ${configPath}`);
  const inScope = (file: string) => CHECKED.some(dir => relative(root, file).startsWith(dir));
  const program = ts.createProgram({ rootNames: parsed.fileNames.filter(inScope), options: parsed.options });
  const checker = program.getTypeChecker();
  const out: string[] = [];
  for (const sf of program.getSourceFiles()) {
    if (sf.isDeclarationFile || !inScope(sf.fileName)) continue;
    const visit = (node: ts.Node): void => {
      if (ts.isExpressionStatement(node)) {
        let expr = node.expression;
        while (ts.isParenthesizedExpression(expr)) expr = expr.expression;
        if (!handled(expr) && thenable(checker, checker.getTypeAtLocation(expr))) {
          const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
          out.push(`${relative(root, sf.fileName)}:${line + 1}: ${node.getText(sf).split("\n")[0].slice(0, 120)}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out.sort();
}

if (import.meta.main) {
  const found = floatingPromises(resolve(process.argv[2] ?? `${import.meta.dir}/..`));
  for (const f of found) console.log(f);
  console.log(`${found.length} floating promise(s)`);
  process.exit(found.length ? 1 : 0);
}
