/**
 * V0 dev hardcoded values — replace with proper UI / persistence in V0.5+.
 *
 * `DEV_CWD` is the working directory new sessions are created under. Daemon's
 * `sendPrompt` requires cwd for session creation (SDK derives the project key
 * from cwd to locate JSONL on `--resume`). Until we ship a cwd picker in
 * (drawer)/index.tsx, change this constant before reload to test different
 * projects.
 */
export const DEV_CWD = "/Users/yangyueqian/Desktop/projects/sidecode/sidecode";
