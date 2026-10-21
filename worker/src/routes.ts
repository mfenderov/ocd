import type { CliScope } from "./tokens";

// The shape of a route, shared by the two routers: the edge (index.ts) and
// the Durable Object (state.ts).
//
// A router is a table of routes and a lookup. The table says what the
// brain answers; the lookup says which row answers a request. Nothing in
// the router decides, so nothing in it can hide a rule.

// A route: the method and path it answers, the scope it needs (a route
// without a scope carries its own auth), and the handler that answers.
export interface Route<THandler> {
  method: string;
  path: PathRule;
  scope?: CliScope;
  handler: THandler;
}

// The path a route answers on.
//
//   exact   — the path is this and nothing else ("/api/backends").
//   wrapped — the path is a head, an id and a tail
//             ("/api/backends/{id}/revoke"). The id may hold a "/": the
//             edge slices it out of the path as it is.
//   segment — the path is a head and one id that may not hold a "/"
//             ("/api/tokens/{id}").
//
// Whether the id must be there is the route's own rule, and the two
// routers differ on it: the edge needs a name ("/api/backends//revoke" is
// no route at all), while the DO answers "bad_request" for an empty one
// ("/revoke/" is a route that names nothing).
export type PathRule =
  | { kind: "exact"; path: string }
  | { kind: "wrapped"; head: string; tail: string; idRequired: boolean }
  | { kind: "segment"; head: string; idRequired: boolean };

// The path, exactly.
export function exact(path: string): PathRule {
  return { kind: "exact", path };
}

// The path with a name in it: the name must be there ("/api/backends/{id}
// /revoke"), and it may hold a "/".
export function requiredId(head: string, tail = ""): PathRule {
  return { kind: "wrapped", head, tail, idRequired: true };
}

// The path with a name in it that may be empty: an empty name still
// reaches the handler, which answers "bad_request" ("/revoke/{id}").
export function optionalId(head: string, tail = ""): PathRule {
  return { kind: "wrapped", head, tail, idRequired: false };
}

// The path with one name in it: the name may not hold a "/", and it must
// be there ("/api/tokens/{id}").
export function singleId(head: string): PathRule {
  return { kind: "segment", head, idRequired: true };
}

// The path with one name in it that may be empty ("/tokens/{id}").
export function optionalSingleId(head: string): PathRule {
  return { kind: "segment", head, idRequired: false };
}

// The id a path names, when the path is this route's path. Null when the
// path is not this route's path; the empty string when the path is, and
// names nothing.
export function matchPath(rule: PathRule, pathname: string): string | null {
  if (rule.kind === "exact") {
    return matchExact(rule, pathname);
  }
  if (rule.kind === "segment") {
    return matchSegment(rule, pathname);
  }
  return matchWrapped(rule, pathname);
}

// The path, exactly.
function matchExact(rule: { path: string }, pathname: string): string | null {
  return pathname === rule.path ? "" : null;
}

// The path with one name in it: the name may not hold a "/".
function matchSegment(rule: { head: string; idRequired: boolean }, pathname: string): string | null {
  if (!pathname.startsWith(rule.head)) {
    return null;
  }
  const id = pathname.slice(rule.head.length);
  if (id.includes("/")) {
    return null;
  }
  if (rule.idRequired && id === "") {
    return null;
  }
  return id;
}

// The path with a name in it: the name may hold a "/".
function matchWrapped(rule: { head: string; tail: string; idRequired: boolean }, pathname: string): string | null {
  if (!pathname.startsWith(rule.head) || !pathname.endsWith(rule.tail)) {
    return null;
  }
  const id = pathname.slice(rule.head.length, pathname.length - rule.tail.length);
  if (rule.idRequired && id === "") {
    return null;
  }
  return id;
}

// The route that answers a request, and the id its path names.
export interface RouteMatch<T> {
  route: T;
  // The id the path names, empty when the path names none.
  id: string;
}

// The first route that answers the method and the path. The table is in
// the order the brain answers, and the first row that matches wins.
export function findRoute<T extends Route<unknown>>(
  routes: readonly T[],
  method: string,
  pathname: string,
): RouteMatch<T> | undefined {
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const id = matchPath(route.path, pathname);
    if (id === null) {
      continue;
    }
    return { route, id };
  }
  return undefined;
}
