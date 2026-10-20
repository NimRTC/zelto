import type { StallClass } from './classifier.js';

export interface StallInfo {
  class: StallClass | null;
  autoResolved: number;
  gateRetries: number;
}
