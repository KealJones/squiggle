// The agent's built-in tools, registered in a fixed order. The order is what the
// model sees (tool specs, the small model's one-line tool list), so keep it stable.
//
// To add a tool: define it in one of these modules (or your own) with defineTool
// and either add it to BUILTIN here or call registerTool() at startup. See
// docs/extending.md.
import { registerTool } from './registry.js';
import { listFiles, readFile, grep, writeFile, editFile, deleteFile } from './files.js';
import { note } from './notes.js';
import { githubListRepos, gitClone, gitStatus, gitBranch, gitCommit, gitPush, gitPull, gitLog, gitShow, githubOpenPr } from './git.js';
import { fetchUrl, webSearch } from './web.js';
import { wikiTool, wikidataQuery } from './wiki.js';
import { remember, recall, forget, searchHistory } from './memory.js';
import { calculate, runJs } from './compute.js';

export const BUILTIN = [
  // Files
  listFiles, readFile, grep, note, writeFile, editFile, deleteFile,
  // Git and GitHub
  githubListRepos, gitClone, gitStatus, gitBranch, gitCommit, gitPush, gitPull, gitLog, gitShow, githubOpenPr,
  // Web
  fetchUrl, webSearch, wikiTool, wikidataQuery,
  // Memory
  remember, recall, forget, searchHistory,
  // Maths and code
  calculate, runJs,
];
for (const t of BUILTIN) registerTool(t);

export { defineTool, registerTool, unregisterTool, getTool, listTools, toolSpecs, runTool, params, str, num, bool, oneOf } from './registry.js';
export { saveWebPage } from './workspace.js';
