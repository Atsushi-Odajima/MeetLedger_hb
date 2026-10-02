import type { ModuleDef } from '../types';
import ledgerRoutes from './routes';
import meetingLedgerRoutes from './meetingRoutes';
import { registerExtractJob } from './extract';

// Public API for other modules (DTO mappers, ACL-aware queries, write services, extraction).
export * from './common';
export * from './mappers';
export * from './queries';
export {
  EDIT_SCHEMAS,
  acceptItem,
  rejectItem,
  editCandidate,
  applyEdits,
  createDecision,
  createDecisionSchema,
  supersedeDecision,
  resolveContradiction,
  setItemStatus,
  pendingInferred,
} from './service';
export { runExtraction, prepareExtraction, persistExtraction, detectContradictions } from './extract';
export { validateExtraction } from './validate';
export { reviewInbox } from './review';
export type { ReviewInbox, ReviewGroup, ReviewItem, ReviewOpts } from './review';
export { contradictionReason, valueSet, valuePart } from './contradictions';
export { extractJobKey, notesVersionHash, COACH_DISCLAIMER_JA, COACH_DISCLAIMER_EN } from './meetingRoutes';

const mod: ModuleDef = {
  name: 'ledger',
  async routes(app, deps) {
    await ledgerRoutes(app, deps);
    await meetingLedgerRoutes(app, deps);
  },
  jobs(worker, deps) {
    registerExtractJob(worker, deps);
  },
};
export default mod;
