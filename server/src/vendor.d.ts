// Migrations are imported `with { type: "text" }` (see db.ts) and resolve to the SQL text.
declare module "*.sql" {
  const text: string;
  export default text;
}
