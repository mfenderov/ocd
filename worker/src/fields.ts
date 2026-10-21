// The field rules the bodies share.
//
// A body is validated by its fields: each field has one rule, and the
// body is valid when every field is. A rule that a field breaks answers
// null, so the body is rejected the same way for every field.

// A field that must carry text: a string that is not empty.
export function textField(value: unknown): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value;
}

// A field that may be absent, but must carry text when it is there.
export function optionalTextField(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return textField(value);
}

// A field that must carry a string, empty or not.
export function stringField(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  return value;
}

// A field that may be absent, but must carry a string when it is there.
export function optionalStringField(value: unknown): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  return stringField(value);
}

// A field that must carry a number above the given one.
export function numberField(value: unknown, min: number): number | null {
  if (typeof value !== "number" || !(value > min)) {
    return null;
  }
  return value;
}

// A field that must carry a whole number, at least the given one.
export function integerField(value: unknown, min: number): number | null {
  if (!Number.isInteger(value) || (value as number) < min) {
    return null;
  }
  return value as number;
}

// A field that may be absent, but must carry a whole number when it is
// there.
export function optionalIntegerField(value: unknown): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value)) {
    return null;
  }
  return value as number;
}
