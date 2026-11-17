/**
 * What ties a field to the message that says what is wrong with it. The message is an alert, said when it comes; tied to the field, it is
 * said again when the focus comes back to the field, where a screen reader otherwise hears « invalid » and not why.
 * `id` comes from `useId()`; `wrong` is whether the message is on screen (the field must not point at an element that is not there).
 */
export function fieldError(id: string, wrong: boolean): { field: { 'aria-invalid': boolean; 'aria-describedby'?: string }; message: { id: string; role: 'alert' } } {
  return { field: { 'aria-invalid': wrong, ...(wrong ? { 'aria-describedby': id } : {}) }, message: { id, role: 'alert' } }
}
