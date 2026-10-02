// data module: export / import / retention / delete / backup / sample workspace.
import type { ModuleDef } from '../types';
import dataRoutes from './routes';
import { runRetentionSweep } from './retention';
import { runExportJob } from './workspaceExport';

const mod: ModuleDef = {
  name: 'data',
  async routes(app, deps) {
    await dataRoutes(app, deps);
  },
  jobs(worker, deps) {
    worker.register('retention.sweep', async () => runRetentionSweep(deps));
    worker.register('export.full', async (job) => runExportJob(deps, job));
  },
};
export default mod;

export { deleteMeetingFully, deleteMeetingAudio, deleteMeetingTranscript, deleteMeetingAiIndex, purgeTranscripts } from './deletion';
export { runRetentionSweep } from './retention';
export { loadMeetingBundle, renderMeeting } from './meetingExport';
export { exportDecisions, exportActionsCsv, exportCommitmentsCsv, projectBook, supersedeChains } from './ledgerExport';
export { writeWorkspaceExport, runExportJob, signExportUrl, verifyExportSignature, exportScope } from './workspaceExport';
export { importWorkspace, parseExportDoc } from './workspaceImport';
export { createBackup, restoreBackup, verifyBackupFiles, keyFingerprint } from './backup';
export { ensureSampleWorkspace } from './sample';
export { toCsv, parseCsv, neutralizeFormula } from './csv';
export { toSrt, toVtt, parseSrt, parseVtt } from './subtitles';
