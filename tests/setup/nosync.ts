// Decision 154: the gate's test workers skip the device flush in fsyncSync and fdatasyncSync (see nosync-fsync.ts).
// Registered in vitest.config.ts. The default import is the fs module object itself, which is what can be assigned to.
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { installNoSync } from "./nosync-fsync.ts";

installNoSync(fs, syncBuiltinESMExports);
