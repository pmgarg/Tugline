/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Modified by Tugline contributors, 2026-10-31: `sanitizeClassifierReason`
 * ported from Qwen Code packages/core/src/permissions/classifier.ts (commit
 * c726d2c); also redacts secrets and strips ANSI escapes and control
 * characters (the reason reaches the main model, the terminal and the journal).
 */
import { redactSecrets } from '../util/text.js';

/**
 * The classifier's reason is written by a model and is interpolated into the tool
 * error the main model reads next. Strip pseudo-tags (iteratively, bounded), ANSI
 * escapes and control characters, collapse whitespace and cap the length so a
 * hostile reason cannot pose as a system message or stage a multi-paragraph
 * injection against the main agent.
 */
export function sanitizeClassifierReason(raw: string, max = 200): string {
  if (!raw) return raw;
  let stripped = raw;
  for (let i = 0; i < 8; i++) {
    const next = stripped.replace(/<[^>]*>/g, '');
    if (next === stripped) break;
    stripped = next;
  }
  stripped = stripped
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, ' ')
    .replace(/[<>]/g, '');
  return redactSecrets(stripped.replace(/\s+/g, ' ').trim()).slice(0, max);
}
