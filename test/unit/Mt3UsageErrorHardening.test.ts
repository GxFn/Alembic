/**
 * Train B MT3 — usage-error hardening regression negatives (RIC-3 trim).
 *
 * The resident MCP-mirror handlers and their shadow schemas were deleted after
 * MCP capability moved to AlembicPlugin. The surviving Alembic-owned negative is
 * bootstrap refine published-recipe cap honesty (relocated to service/bootstrap).
 */

import { describe, expect, it } from 'vitest';
import {
  formatPublishedTitles,
  PUBLISHED_TITLES_PROMPT_CAP,
} from '../../lib/recipe-pipeline/generate/runtime/GenerateRefine.js';

describe('MT3 usage-error hardening', () => {
  describe('bootstrap refine prompt cap honesty', () => {
    it('declares truncation when more than the cap of published recipes exist', () => {
      const titles = Array.from({ length: 25 }, (_, i) => `Recipe-${i + 1}`);
      const rendered = formatPublishedTitles(titles);
      expect(rendered).toContain(`前 ${PUBLISHED_TITLES_PROMPT_CAP} 个`);
      expect(rendered).toContain('共 25 个');
      expect(rendered).toContain('Recipe-20');
      expect(rendered).not.toContain('Recipe-21');
    });

    it('renders the full list without truncation wording when under the cap', () => {
      const rendered = formatPublishedTitles(['A', 'B']);
      expect(rendered).toBe('已发布的 Recipe: A, B');
    });
  });
});
