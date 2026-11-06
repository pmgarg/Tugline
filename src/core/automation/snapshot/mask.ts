/**
 * Masking (SPEC E2 AC5, E8): password values never leave the snapshot layer,
 * and text that looks like a credential, or equals a secret the vault handed
 * out, is redacted from everything the model or a recording sees.
 */
import type { UiNode } from '../types.js';
import { redactSecrets } from '../../util/text.js';
import { walk } from './tree.js';

export const MASKED = '•••';

/** Replace password values in place (the driver marks those nodes with state 'password'). */
export function maskPasswords(root: UiNode): number {
  let n = 0;
  walk(root, (x) => {
    if (x.states?.includes('password') && x.value !== undefined && x.value !== '') {
      x.value = MASKED;
      n++;
    }
  });
  return n;
}

/** A redaction function: exact secret values → •••, then generic credential patterns. */
export function makeMasker(values: () => string[]): (s: string) => string {
  return (s: string) => {
    let out = s;
    for (const v of values()) if (v && v.length >= 4) out = out.split(v).join(MASKED);
    return redactSecrets(out);
  };
}
