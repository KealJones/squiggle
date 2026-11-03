// UI state shared by the modules under ui/. One object, mutated in place, so
// every module sees the same values without getters and setters everywhere.
export const state = {
  current: null,            // session in the main view
  openThreadId: null,       // thread shown in the drawer
  drawerPanel: null,        // 'thread' | 'notes' | 'memory' | 'files' | 'settings' | 'context' | null
  busy: false,              // a reply is running
  controller: null,         // AbortController of the running turn
  liveTurn: null,           // { ctx, tools, task } while a reply runs in the main chat (for the details sidebar)
  modelState: 'unknown',    // 'missing' | 'downloading' | 'loading' | 'ready' | 'unsupported' | 'error' | 'idle' | 'unknown'
  modelPromise: null,       // the in-flight ensureModel()
  cloudOffered: false,      // the relay offers the cloud model (checked once at startup)
  call: null,               // { ctl, bar, nv } while a voice call is on
  reader: null,             // { id, ctl } while a reply is read aloud
  readerVoice: null,        // { nv, timer } natural voice kept between readings
};
