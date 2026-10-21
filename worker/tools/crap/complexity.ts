import ts from "typescript";

/**
 * A function found in a source file, with the complexity the CRAP score
 * needs.
 */
export interface FunctionInfo {
  /** The function's name, or a readable stand-in for an anonymous one. */
  name: string;
  /** The file the function lives in. */
  file: string;
  /** The first line of the function's body, 1-based. */
  startLine: number;
  /** The last line of the function, 1-based. */
  endLine: number;
  /** The cyclomatic complexity: one plus the decision points. */
  complexity: number;
}

/**
 * The kinds that are a decision on their own. A switch of many kinds
 * would count as many decisions, so the kinds that always branch live
 * here instead.
 */
const BRANCHING_KINDS: ReadonlySet<ts.SyntaxKind> = new Set([
  ts.SyntaxKind.IfStatement,
  ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForInStatement,
  ts.SyntaxKind.ForOfStatement,
  ts.SyntaxKind.WhileStatement,
  ts.SyntaxKind.DoStatement,
  ts.SyntaxKind.CatchClause,
  ts.SyntaxKind.ConditionalExpression,
  ts.SyntaxKind.CaseClause,
]);

/**
 * The decision points that make a function hard to follow. The rules
 * mirror gocrap (the Go tool this one is a twin of), with the two
 * constructs Go does not have — the ternary and the catch — counted
 * here so the two codebases are measured on the same scale. The
 * `default` of a switch is not a decision, the way gocyclo reads it.
 */
function isDecisionPoint(node: ts.Node): boolean {
  if (BRANCHING_KINDS.has(node.kind)) {
    return true;
  }
  if (node.kind === ts.SyntaxKind.BinaryExpression) {
    return isShortCircuit(node as ts.BinaryExpression);
  }
  return false;
}

/**
 * The binary operators that branch: && and || short-circuit, and so does
 * ??. A plain comparison does not.
 */
function isShortCircuit(node: ts.BinaryExpression): boolean {
  const kind = node.operatorToken.kind;
  return (
    kind === ts.SyntaxKind.AmpersandAmpersandToken ||
    kind === ts.SyntaxKind.BarBarToken ||
    kind === ts.SyntaxKind.QuestionQuestionToken
  );
}

/**
 * The complexity of one function body: one, plus every decision point
 * inside it. A nested function is counted on its own, never here: a
 * function's complexity belongs to the function, and the coverage that
 * goes with it belongs to the function too. The README says why.
 */
export function complexityOf(node: ts.Node): number {
  let complexity = 1;
  const walk = (current: ts.Node): void => {
    if (current !== node && isFunctionLike(current)) {
      return; // the nested function carries its own complexity
    }
    if (isDecisionPoint(current)) {
      complexity += 1;
    }
    ts.forEachChild(current, walk);
  };
  walk(node);
  return complexity;
}

/** Whether a node is a function of any flavour. */
function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node)
  );
}

/** The name a function is known by, including its class or object prefix. */
function nameOf(node: ts.Node, source: ts.SourceFile): string {
  if (ts.isFunctionDeclaration(node) && node.name) {
    return node.name.text;
  }
  if (ts.isMethodDeclaration(node)) {
    return methodName(node, source);
  }
  return boundName(node, source);
}

/** The name of a method, prefixed with its class or object. */
function methodName(node: ts.MethodDeclaration, source: ts.SourceFile): string {
  const owner = ownerName(node);
  const name = node.name.getText(source);
  return owner === "" ? name : `${owner}.${name}`;
}

/**
 * The name of a function that is bound to something: an arrow function
 * takes the name of its variable, a function expression the name of its
 * property.
 */
function boundName(node: ts.Node, source: ts.SourceFile): string {
  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent)) {
    return parent.name.getText(source);
  }
  return "<anonymous>";
}

/** The class or object literal a method belongs to, if any. */
function ownerName(node: ts.Node): string {
  const parent = node.parent;
  if (ts.isClassDeclaration(parent) && parent.name) {
    return parent.name.text;
  }
  if (ts.isObjectLiteralExpression(parent)) {
    return "object";
  }
  return "";
}

/** The first and last line of a node, 1-based. */
function linesOf(node: ts.Node, source: ts.SourceFile): { start: number; end: number } {
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { start, end };
}

/**
 * Every function in a source file, with its complexity. The file's
 * exported and top-level functions come first, then the methods, then
 * the nested ones — the order does not matter for the score, only the
 * list does.
 */
function functionsIn(file: string, source: ts.SourceFile): FunctionInfo[] {
  const found: FunctionInfo[] = [];
  const visit = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      const { start, end } = linesOf(node, source);
      found.push({
        name: nameOf(node, source),
        file,
        startLine: start,
        endLine: end,
        complexity: complexityOf(node),
      });
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(source, visit);
  return found;
}

/** The functions in a file on disk. */
export function functionsInFile(path: string, text: string): FunctionInfo[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.ES2022, true);
  return functionsIn(path, source);
}
