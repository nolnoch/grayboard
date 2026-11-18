// `import x from "./f.sql" with { type: "text" }`: Bun embeds the file's text (also under `bun build --compile`).
declare module "*.sql" { const text: string; export default text; }
