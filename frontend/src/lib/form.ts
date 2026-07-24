/**
 * Minimal form state + inline validation, shared by every form from Phase 1 on.
 * Deliberately dependency-free: a small useForm hook plus a set of composable
 * validators. Fields validate on blur and on submit, never on every keystroke,
 * so the user isn't scolded mid-typing.
 */
import { useCallback, useState } from "react";

export type Validator = (value: string, all: Record<string, string>) => string | null;

export const validators = {
  required:
    (message = "This field is required."): Validator =>
    (v) =>
      v.trim() ? null : message,

  email:
    (message = "Enter a valid email address."): Validator =>
    (v) =>
      /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.trim()) ? null : message,

  minLength:
    (n: number, message?: string): Validator =>
    (v) =>
      v.length >= n ? null : (message ?? `Must be at least ${n} characters.`),

  matches:
    (field: string, message = "Values do not match."): Validator =>
    (v, all) =>
      v === all[field] ? null : message,
};

export function combine(...list: Validator[]): Validator {
  return (value, all) => {
    for (const validate of list) {
      const error = validate(value, all);
      if (error) return error;
    }
    return null;
  };
}

type Schema = Record<string, Validator | undefined>;

export function useForm<T extends Record<string, string>>(
  initial: T,
  schema: Schema = {},
) {
  const [values, setValues] = useState<T>(initial);
  const [errors, setErrors] = useState<Partial<Record<keyof T, string>>>({});
  const [touched, setTouched] = useState<Partial<Record<keyof T, boolean>>>({});

  const validateField = useCallback(
    (name: keyof T, all: T): string | null => {
      const validate = schema[name as string];
      return validate ? validate(all[name], all) : null;
    },
    [schema],
  );

  const setValue = useCallback(
    (name: keyof T, value: string) => {
      setValues((prev) => {
        const next = { ...prev, [name]: value };
        // Re-validate a field the user has already left, so a correction clears
        // its error immediately rather than lingering until the next blur.
        if (touched[name]) {
          setErrors((e) => ({ ...e, [name]: validateField(name, next) ?? undefined }));
        }
        return next;
      });
    },
    [touched, validateField],
  );

  const onBlur = useCallback(
    (name: keyof T) => {
      setTouched((t) => ({ ...t, [name]: true }));
      setErrors((e) => ({ ...e, [name]: validateField(name, values) ?? undefined }));
    },
    [values, validateField],
  );

  const validateAll = useCallback((): boolean => {
    const next: Partial<Record<keyof T, string>> = {};
    let ok = true;
    for (const name of Object.keys(schema) as (keyof T)[]) {
      const error = validateField(name, values);
      if (error) {
        next[name] = error;
        ok = false;
      }
    }
    setErrors(next);
    setTouched(
      Object.fromEntries(Object.keys(values).map((k) => [k, true])) as Partial<
        Record<keyof T, boolean>
      >,
    );
    return ok;
  }, [schema, values, validateField]);

  const reset = useCallback(() => {
    setValues(initial);
    setErrors({});
    setTouched({});
  }, [initial]);

  return { values, errors, touched, setValue, onBlur, validateAll, reset };
}
