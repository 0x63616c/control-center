import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { describe, expect, it } from "vitest";

type CopyRule = Readonly<{ id: string; pattern: RegExp }>;
type Literal = Readonly<{ text: string; offset: number }>;
type Violation = Readonly<{
  column: number;
  file: string;
  line: number;
  rule: string;
  text: string;
}>;

const PRODUCT_ROOT = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const RUNTIME_SOURCE_ROOTS = [
  resolve(PRODUCT_ROOT, "apps/frontend/src"),
  resolve(PRODUCT_ROOT, "apps/api/src"),
  resolve(PRODUCT_ROOT, "contracts"),
] as const;
const RUNTIME_HTML_FILES = [resolve(PRODUCT_ROOT, "apps/frontend/index.html")] as const;

const PROHIBITED_COPY: readonly CopyRule[] = [
  { id: "shame", pattern: /\b(?:ashamed|shame|shamed|shaming)\b/i },
  { id: "guilt", pattern: /\b(?:guilt|guilty)\b/i },
  { id: "snitch", pattern: /\b(?:snitch|snitched|snitches|snitching)\b/i },
  { id: "carnage", pattern: /\bcarnage\b/i },
  { id: "disgrace", pattern: /\b(?:disgrace|disgraced|disgraceful)\b/i },
  { id: "poor-impulse-control", pattern: /\bpoor impulse control\b/i },
  {
    id: "payment-teasing",
    pattern:
      /\b(?:amount owed|apple pay|in the hole|pay up|payments? (?:are )?coming soon|real payments?|settle up|stripe|you owe)\b/i,
  },
  {
    id: "payment-pressure",
    pattern:
      /\b(?:balance due|cash|charge now|debt|fine|penalties|penalty|pay\s+\d+\s*(?:points?|pts))\b/i,
  },
  { id: "currency-amount", pattern: /\$\s*\d+(?:\.\d+)?/i },
] as const;

const MESSAGE_ACCESS_DISCLOSURE =
  /\b(?:does not|doesn't|never)\s+(?:access|monitor|read|scan)\s+(?:your\s+)?(?:messages?|texts?)\b/i;
const MONEY_DISCLOSURES = [
  /\b(?:does not|doesn't|never)\s+(?:charge|collect|move|pay|process|transfer)\w*(?:\s+\w+){0,6}\s+(?:real\s+)?money\b/i,
  /\bno\s+(?:real\s+)?money\s+(?:is\s+)?(?:charged|collected|moved|paid|processed|transferred)\b/i,
] as const;

function normalizeCopy(value: string): string {
  return value
    .replace(/[‘’]/g, "'")
    .replace(/[‐‑‒–—]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function relativeProductPath(path: string): string {
  return relative(PRODUCT_ROOT, path).replaceAll("\\", "/");
}

function isRuntimeSource(path: string): boolean {
  const relativePath = relativeProductPath(path);
  if (!new Set([".ts", ".tsx"]).has(extname(path))) return false;
  return !(
    /(?:^|\/)__tests__\//.test(relativePath) ||
    /(?:^|\/)db\/migrations\//.test(relativePath) ||
    /\.(?:spec|stories|test)\.[^.]+$/.test(relativePath)
  );
}

function discoverRuntimeSourceFiles(): string[] {
  const discovered: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && isRuntimeSource(path)) discovered.push(path);
    }
  };
  for (const root of RUNTIME_SOURCE_ROOTS) visit(root);
  return [...discovered, ...RUNTIME_HTML_FILES].sort();
}

function typescriptLiterals(source: string, fileName = "fixture.tsx"): Literal[] {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const literals: Literal[] = [];

  const staticText = (node: ts.Node): string | null => {
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) return node.text;
    if (ts.isParenthesizedExpression(node)) return staticText(node.expression);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = staticText(node.left);
      const right = staticText(node.right);
      return left === null || right === null ? null : `${left} ${right}`;
    }
    if (ts.isJsxExpression(node)) return node.expression ? staticText(node.expression) : "";
    if (ts.isJsxElement(node)) {
      return node.children
        .map(staticText)
        .filter((text): text is string => text !== null)
        .join(" ");
    }
    if (ts.isJsxFragment(node)) {
      return node.children
        .map(staticText)
        .filter((text): text is string => text !== null)
        .join(" ");
    }
    return null;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isTemplateExpression(node)) {
      literals.push({
        text: [node.head.text, ...node.templateSpans.map((span) => span.literal.text)].join(" "),
        offset: node.getStart(sourceFile),
      });
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    if (
      ts.isJsxElement(node) ||
      ts.isJsxFragment(node) ||
      (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken)
    ) {
      const text = staticText(node);
      if (text?.trim()) literals.push({ text, offset: node.getStart(sourceFile) });
    }
    if (ts.isStringLiteralLike(node) || ts.isJsxText(node)) {
      literals.push({ text: node.text, offset: node.getStart(sourceFile) });
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
  return literals;
}

function htmlLiterals(source: string): Literal[] {
  const literals: Literal[] = [];
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, (comment) =>
    " ".repeat(comment.length),
  );
  const token = />([^<]+)</g;
  for (const match of withoutComments.matchAll(token)) {
    if (match[1]?.trim()) literals.push({ text: match[1], offset: (match.index ?? 0) + 1 });
  }
  const attribute = /\b(?:aria-label|content|title)=(?:"([^"]*)"|'([^']*)')/gi;
  for (const match of withoutComments.matchAll(attribute)) {
    const text = match[1] ?? match[2];
    if (text?.trim()) {
      const valueOffset = match[0].indexOf(text);
      literals.push({ text, offset: (match.index ?? 0) + valueOffset });
    }
  }
  return literals;
}

function literalsFor(path: string, source = readFileSync(path, "utf8")): Literal[] {
  return path.endsWith(".html") ? htmlLiterals(source) : typescriptLiterals(source, path);
}

function lineAndColumn(source: string, offset: number): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

function violationsFor(path: string, source = readFileSync(path, "utf8")): Violation[] {
  const violations: Violation[] = [];
  const relativePath = relativeProductPath(path);
  for (const literal of literalsFor(path, source)) {
    const normalized = normalizeCopy(literal.text);
    for (const rule of PROHIBITED_COPY) {
      if (
        rule.id === "currency-amount" &&
        relativePath.startsWith("apps/api/") &&
        /^(?:(?:delete\b[\s\S]*\bfrom|insert\b[\s\S]*\binto|select\b[\s\S]*\bfrom|update\b[\s\S]*\bset)\b|select\s+[a-z_][a-z0-9_]*\s*\(|with\s+[a-z_][a-z0-9_]*(?:\s*\([^)]*\))?\s+as\s*\()/i.test(
          normalized,
        )
      ) {
        continue;
      }
      if (!rule.pattern.test(normalized)) continue;
      const location = lineAndColumn(source, literal.offset);
      violations.push({
        ...location,
        file: relativeProductPath(path),
        rule: rule.id,
        text: normalized.slice(0, 160),
      });
    }
  }
  return violations;
}

function formatViolations(violations: readonly Violation[]): string {
  return violations
    .map(
      ({ file, line, column, rule, text }) =>
        `${file}:${line}:${column} [${rule}] ${JSON.stringify(text)}`,
    )
    .join("\n");
}

describe("runtime copy policy scanner", () => {
  it("finds prohibited JSX, string, and interpolated-template copy", () => {
    const source = `
      const label = "Guilt scoreboard";
      const amount = 10;
      const detail = \`Pay \${amount} up\`;
      export const View = () => <p>Wall of shame</p>;
    `;

    expect(
      new Set(violationsFor(resolve(PRODUCT_ROOT, "fixture.tsx"), source).map((v) => v.rule)),
    ).toEqual(new Set(["guilt", "payment-teasing", "shame"]));
  });

  it("finds prohibited copy split across static JSX and concatenated literals", () => {
    const source = `
      const payment = "Pay " + "up";
      export const View = () => <p>Payments <strong>coming soon</strong></p>;
    `;

    expect(violationsFor(resolve(PRODUCT_ROOT, "fixture.tsx"), source).map((v) => v.rule)).toEqual([
      "payment-teasing",
      "payment-teasing",
    ]);
  });

  it("finds currency and payment-pressure copy without rejecting safety disclosures", () => {
    const source = `
      const dollar = "$5";
      const cash = "Cash penalty";
      const due = "Balance due";
      const charge = "Charge now";
      const points = "Pay 5 points";
      const safe = "No real money is charged, collected, paid, or transferred.";
    `;

    expect(violationsFor(resolve(PRODUCT_ROOT, "fixture.ts"), source).map((v) => v.rule)).toEqual([
      "currency-amount",
      "payment-pressure",
      "payment-pressure",
      "payment-pressure",
      "payment-pressure",
    ]);
  });

  it("does not mistake frontend copy containing SQL-like words for a query", () => {
    const source = `export const View = () => <p>Update your tally with $5</p>;`;

    expect(
      new Set(
        violationsFor(resolve(PRODUCT_ROOT, "apps/frontend/src/fixture.tsx"), source).map(
          (v) => v.rule,
        ),
      ),
    ).toEqual(new Set(["currency-amount"]));
  });

  it("allows positional placeholders in API SQL literals", () => {
    const source = `
      const updateQuery = "update memberships set tally_cents = $1 where id = $2";
      const cteQuery = "with candidates(id) as (select id from events where id = $5) select * from candidates";
      const lockQuery = "select pg_advisory_xact_lock(hashtextextended($1, 0))";
    `;

    expect(violationsFor(resolve(PRODUCT_ROOT, "apps/api/src/fixture.ts"), source)).toEqual([]);
  });

  it("still rejects API-generated public copy that begins with a SQL verb", () => {
    const source = `const message = "Update your tally with $5";`;

    expect(
      new Set(
        violationsFor(resolve(PRODUCT_ROOT, "apps/api/src/fixture.ts"), source).map((v) => v.rule),
      ),
    ).toEqual(new Set(["currency-amount"]));
  });

  it("ignores comments and identifiers while accepting explicit safety disclosures", () => {
    const source = `
      // Payments coming soon. Wall of shame.
      const shameRow = "We never read your messages.";
      const disclosure = "No real money is collected or transferred.";
    `;

    expect(violationsFor(resolve(PRODUCT_ROOT, "fixture.ts"), source)).toEqual([]);
  });

  it("ignores historical wording inside HTML comments", () => {
    const source = `<!-- Payments coming soon. --><meta name="description" content="Supportive accountability">`;

    expect(violationsFor(resolve(PRODUCT_ROOT, "fixture.html"), source)).toEqual([]);
  });
});

describe("Don't Text Your Ex runtime copy policy", () => {
  const runtimeFiles = discoverRuntimeSourceFiles();
  const runtimePaths = runtimeFiles.map(relativeProductPath);
  const visibleFrontendLiterals = runtimeFiles
    .filter((path) => {
      const relativePath = relativeProductPath(path);
      return (
        relativePath.startsWith("apps/frontend/src/screens/") ||
        relativePath === "apps/frontend/src/theme.ts" ||
        path.endsWith("index.html")
      );
    })
    .flatMap((path) => literalsFor(path).map((literal) => normalizeCopy(literal.text)));

  it("covers the public frontend and server-generated copy seams", () => {
    expect(runtimePaths).toContain("apps/frontend/src/screens/Onboarding.tsx");
    expect(runtimePaths).toContain("apps/frontend/src/screens/Profile.tsx");
    expect(runtimePaths).toContain("apps/api/src/store.ts");
    expect(runtimePaths).toContain("apps/frontend/index.html");
    expect(runtimePaths.some((path) => path.includes("docs/design-reference"))).toBe(false);
  });

  it("contains no prohibited public or runtime literals", () => {
    const violations = runtimeFiles.flatMap((path) => violationsFor(path));

    expect(violations, `Prohibited runtime copy:\n${formatViolations(violations)}`).toEqual([]);
  });

  it("visibly states that the app does not read users' messages", () => {
    expect(visibleFrontendLiterals.some((copy) => MESSAGE_ACCESS_DISCLOSURE.test(copy))).toBe(true);
  });

  it("visibly states that no real money is charged, collected, paid, or transferred", () => {
    expect(
      visibleFrontendLiterals.some((copy) =>
        MONEY_DISCLOSURES.some((pattern) => pattern.test(copy)),
      ),
    ).toBe(true);
  });
});
