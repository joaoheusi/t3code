import { environmentAtomList } from "./environmentAtomList";
import { serverEnvironment } from "./server";

export const scheduledTaskCreatePermissionsAtom = environmentAtomList(
  "web-scheduled-task-create-permissions",
  serverEnvironment.upsertScheduledTask.permissionAtom,
);
