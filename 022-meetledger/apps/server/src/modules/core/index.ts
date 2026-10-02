import type { ModuleDef } from '../types';
import authRoutes from './auth';
import workspaceRoutes from './workspaces';
import meetingRoutes from './meetings';
import directoryRoutes from './directory';

const mod: ModuleDef = {
  name: 'core',
  async routes(app, deps) {
    await authRoutes(app, deps);
    await workspaceRoutes(app, deps);
    await meetingRoutes(app, deps);
    await directoryRoutes(app, deps);
  },
};
export default mod;
