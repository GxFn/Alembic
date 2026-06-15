import type { ServiceContainer } from '../ServiceContainer.js';

/**
 * Retired project-information provider.
 *
 * Project facts now flow through ProjectContext consumers; this module remains
 * as a compatibility import target without registering legacy services.
 */
export const PanoramaModule = {
  register(_container: ServiceContainer): void {
    return;
  },
};
