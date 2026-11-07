import { useEffect, useState, type ReactNode } from 'react';

/** A labelled control with a one-line hint and its default. */
export function Field(props: { label: string; hint?: string; def?: string | number; error?: string | null; children: ReactNode }) {
  return (
    <label className={`field ${props.error ? 'invalid' : ''}`}>
      <span className="field-label">{props.label}</span>
      {props.children}
      {props.error ? (
        <span className="field-error" role="alert">{props.error}</span>
      ) : (
        (props.hint || props.def !== undefined) && (
          <span className="hint">
            {props.hint}
            {props.def !== undefined && <span className="def"> Default {String(props.def)}.</span>}
          </span>
        )
      )}
    </label>
  );
}

/** A number input checked in place: out-of-range values show a message and are not saved. */
export function NumField(props: { label: string; hint?: string; value: number; def: number; min: number; max?: number; step?: number; unit?: string; onSave: (n: number) => void }) {
  const [text, setText] = useState(String(props.value));
  useEffect(() => setText(String(props.value)), [props.value]);
  const n = Number(text);
  const error =
    text.trim() === '' || !Number.isFinite(n)
      ? 'Enter a number.'
      : n < props.min || (props.max !== undefined && n > props.max)
        ? `Must be ${props.max !== undefined ? `between ${props.min} and ${props.max}` : `at least ${props.min}`}.`
        : null;
  return (
    <Field label={props.label} hint={props.hint} def={`${props.def}${props.unit ?? ''}`} error={error}>
      <input
        type="number"
        value={text}
        min={props.min}
        max={props.max}
        step={props.step}
        aria-invalid={Boolean(error)}
        onChange={(e) => {
          setText(e.target.value);
          const v = Number(e.target.value);
          const ok = e.target.value.trim() !== '' && Number.isFinite(v) && v >= props.min && (props.max === undefined || v <= props.max);
          if (ok && v !== props.value) props.onSave(v);
        }}
      />
    </Field>
  );
}

export function Toggle(props: { label: string; hint?: string; checked: boolean; def: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="toggle-row">
      <span className="switch">
        <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
        <span />
      </span>
      <span>
        <span className="field-label">{props.label}</span>
        <span className="hint">
          {props.hint} <span className="def">Default {props.def ? 'on' : 'off'}.</span>
        </span>
      </span>
    </label>
  );
}
